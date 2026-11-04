import { type SQL, and, count, eq, ilike, inArray, or } from "drizzle-orm";
import type { z } from "zod";
import { getDb } from "../../db/client";
import { departments, programs, studentProfiles, users } from "../../db/schema";
import {
  type AuthContext,
  canAccessDepartment,
  departmentScope,
  hasRole,
} from "../../middleware/auth";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { publicUser } from "../auth/service";
import { effectiveDepartmentId } from "../departments/service";
import type { listStudentsSchema, profilePatchSchema, rejectSchema } from "./schemas";

/**
 * The full student directory for institution-wide Admin or a department's
 * HOD/Dean. Unlike the verification queue this includes every status, so the
 * oversight view can see who is pending, active or rejected.
 */
export async function listStudents(auth: AuthContext, input: z.infer<typeof listStudentsSchema>) {
  const { db } = getDb();
  const admin = hasRole(auth, "ADMIN");
  const senior = departmentScope(auth, "HOD_DEAN");
  const filters: SQL[] = [eq(users.accountType, "COLLEGE_STUDENT")];
  if (!admin) {
    if (senior.global) {
      // Institution-wide HOD/Dean sees every department.
    } else if (senior.departmentIds.length) {
      filters.push(inArray(studentProfiles.departmentId, senior.departmentIds));
    } else {
      return { items: [], total: 0, limit: input.limit, offset: input.offset, hasMore: false };
    }
  }
  if (input.departmentId) filters.push(eq(studentProfiles.departmentId, input.departmentId));
  if (input.status) filters.push(eq(users.status, input.status));
  if (input.q) {
    const search = or(
      ilike(users.fullName, `%${input.q}%`),
      ilike(users.email, `%${input.q}%`),
      ilike(studentProfiles.rollNumber, `%${input.q}%`),
      ilike(users.phone, `%${input.q}%`),
    );
    if (search) filters.push(search);
  }
  const where = and(...filters);
  const rows = await db
    .select({
      user: users,
      profile: studentProfiles,
      departmentName: departments.name,
      programName: programs.name,
    })
    .from(users)
    .innerJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, studentProfiles.departmentId))
    .leftJoin(programs, eq(programs.id, studentProfiles.programId))
    .where(where)
    .orderBy(users.fullName, users.id)
    .limit(input.limit + 1)
    .offset(input.offset);
  const [totalRow] = await db
    .select({ n: count() })
    .from(users)
    .innerJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(where);
  return {
    items: rows.slice(0, input.limit).map((r) => ({
      id: r.user.id,
      fullName: r.user.fullName,
      email: r.user.email,
      phone: r.user.phone,
      status: r.user.status,
      accountType: r.user.accountType,
      emailVerifiedAt: r.user.emailVerifiedAt,
      createdAt: r.user.createdAt,
      profile: r.profile,
      departmentName: r.departmentName,
      programName: r.programName,
    })),
    total: totalRow?.n ?? 0,
    limit: input.limit,
    offset: input.offset,
    hasMore: rows.length > input.limit,
  };
}

export async function listVerificationQueue(
  auth: AuthContext,
  page: { limit: number; offset: number } = { limit: 25, offset: 0 },
) {
  const { db } = getDb();
  const scope = departmentScope(auth, "FACULTY");
  const seniorScope = departmentScope(auth, "HOD_DEAN");
  const deptFilters: SQL[] = [];
  if (hasRole(auth, "FACULTY") && !scope.global && scope.departmentIds.length)
    deptFilters.push(inArray(studentProfiles.departmentId, scope.departmentIds));
  if (hasRole(auth, "HOD_DEAN") && !seniorScope.global && seniorScope.departmentIds.length)
    deptFilters.push(inArray(studentProfiles.departmentId, seniorScope.departmentIds));
  const globalAccess =
    (hasRole(auth, "FACULTY") && scope.global) || (hasRole(auth, "HOD_DEAN") && seniorScope.global);
  if (!globalAccess && deptFilters.length === 0)
    return { items: [], hasMore: false, limit: page.limit, offset: page.offset };
  const rows = await db
    .select({ user: users, profile: studentProfiles })
    .from(users)
    .innerJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(
      and(
        eq(users.accountType, "COLLEGE_STUDENT"),
        eq(users.status, "PENDING_VERIFICATION"),
        globalAccess ? undefined : or(...deptFilters),
      ),
    )
    .orderBy(users.createdAt, users.id)
    .limit(page.limit + 1)
    .offset(page.offset);
  return {
    items: rows.slice(0, page.limit).map((r) => ({
      id: r.user.id,
      email: r.user.email,
      fullName: r.user.fullName,
      phone: r.user.phone,
      status: r.user.status,
      profile: r.profile,
    })),
    hasMore: rows.length > page.limit,
    limit: page.limit,
    offset: page.offset,
  };
}

async function getCollegeStudentInScope(auth: AuthContext, id: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ user: users, profile: studentProfiles })
    .from(users)
    .innerJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(and(eq(users.id, id), eq(users.accountType, "COLLEGE_STUDENT")))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Student not found.");
  const canFaculty =
    hasRole(auth, "ADMIN") ||
    (hasRole(auth, "FACULTY") && canAccessDepartment(auth, "FACULTY", row.profile.departmentId));
  const canSeniorRead =
    hasRole(auth, "HOD_DEAN") && canAccessDepartment(auth, "HOD_DEAN", row.profile.departmentId);
  if (!canFaculty && !canSeniorRead)
    throw new ApiError("FORBIDDEN", "Student is outside your scope.");
  return row;
}

export async function getStudent(auth: AuthContext, id: string) {
  const row = await getCollegeStudentInScope(auth, id);
  return { user: publicUser(row.user), profile: row.profile };
}

export async function verifyStudent(
  auth: AuthContext,
  id: string,
  audit?: AuditContext,
  note?: string,
) {
  if (!hasRole(auth, "FACULTY"))
    throw new ApiError("FORBIDDEN", "Only faculty can verify students.");
  const row = await getCollegeStudentInScope(auth, id);
  if (!canAccessDepartment(auth, "FACULTY", row.profile.departmentId))
    throw new ApiError("FORBIDDEN", "Student is outside your faculty scope.");
  if (row.user.status !== "PENDING_VERIFICATION" || !row.user.emailVerifiedAt)
    throw new ApiError("CONFLICT", "Only email-verified pending students can be verified.");
  const { db } = getDb();
  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({
        status: "ACTIVE",
        ...(row.user.phone ? { phoneVerifiedAt: row.user.phoneVerifiedAt ?? new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    const [profile] = await tx
      .update(studentProfiles)
      .set({
        verifiedBy: auth.user.id,
        verifiedAt: new Date(),
        rejectionReason: null,
        profileVersion: row.profile.profileVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(studentProfiles.userId, id))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "FACULTY_STUDENT_VERIFIED",
        entityType: "user",
        entityId: id,
        after: { status: user?.status, note },
      });
    return { user: user ? publicUser(user) : null, profile };
  });
  return result;
}

export async function rejectStudent(
  auth: AuthContext,
  id: string,
  input: z.infer<typeof rejectSchema>,
  audit?: AuditContext,
) {
  if (!hasRole(auth, "FACULTY"))
    throw new ApiError("FORBIDDEN", "Only faculty can reject students.");
  const row = await getCollegeStudentInScope(auth, id);
  if (!canAccessDepartment(auth, "FACULTY", row.profile.departmentId))
    throw new ApiError("FORBIDDEN", "Student is outside your faculty scope.");
  if (row.user.status !== "PENDING_VERIFICATION")
    throw new ApiError("CONFLICT", "Only pending students can be rejected.");
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ status: "REJECTED", updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    const [profile] = await tx
      .update(studentProfiles)
      .set({
        rejectionReason: input.reason,
        profileVersion: row.profile.profileVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(studentProfiles.userId, id))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "FACULTY_STUDENT_REJECTED",
        entityType: "user",
        entityId: id,
        after: { status: user?.status, reason: input.reason },
      });
    return { user: user ? publicUser(user) : null, profile };
  });
}

export async function patchStudentProfile(
  auth: AuthContext,
  id: string,
  input: z.infer<typeof profilePatchSchema>,
  audit?: AuditContext,
) {
  const admin = hasRole(auth, "ADMIN");
  const faculty = hasRole(auth, "FACULTY");
  const senior = hasRole(auth, "HOD_DEAN");
  if (!admin && !faculty && !senior)
    throw new ApiError(
      "FORBIDDEN",
      "Only faculty, an HOD/Dean or an administrator can correct student profiles.",
    );
  const row = await getCollegeStudentInScope(auth, id);
  const inScope =
    admin ||
    (faculty && canAccessDepartment(auth, "FACULTY", row.profile.departmentId)) ||
    (senior && canAccessDepartment(auth, "HOD_DEAN", row.profile.departmentId));
  if (!inScope) throw new ApiError("FORBIDDEN", "Student is outside your scope.");
  let resolvedDepartmentId = input.departmentId;
  if (input.programId !== undefined || input.studyYear !== undefined) {
    const programId = input.programId === undefined ? row.profile.programId : input.programId;
    if (programId) {
      const [program] = await getDb()
        .db.select()
        .from(programs)
        .where(eq(programs.id, programId))
        .limit(1);
      if (!program) throw new ApiError("VALIDATION_ERROR", "Programme not found.");
      const studyYear = input.studyYear === undefined ? row.profile.studyYear : input.studyYear;
      resolvedDepartmentId = effectiveDepartmentId(program, studyYear);
      if (!resolvedDepartmentId)
        throw new ApiError(
          "VALIDATION_ERROR",
          "This programme has no department yet. Set one in Administration → Departments.",
        );
    }
  }
  if (resolvedDepartmentId !== undefined) {
    if (resolvedDepartmentId === null)
      throw new ApiError("VALIDATION_ERROR", "College students require a department.");
    const targetInScope =
      admin ||
      (faculty && canAccessDepartment(auth, "FACULTY", resolvedDepartmentId)) ||
      (senior && canAccessDepartment(auth, "HOD_DEAN", resolvedDepartmentId));
    if (!targetInScope) throw new ApiError("FORBIDDEN", "Target department is outside your scope.");
  }
  const { db } = getDb();
  const before = { user: publicUser(row.user), profile: row.profile };
  let result: {
    user: ReturnType<typeof publicUser>;
    profile: typeof studentProfiles.$inferSelect | undefined;
  };
  try {
    result = await db.transaction(async (tx) => {
      let user = row.user;
      if (input.fullName !== undefined || input.phone !== undefined) {
        const [u] = await tx
          .update(users)
          .set({
            ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.phone !== undefined && input.phone !== null
              ? { phoneVerifiedAt: new Date() }
              : {}),
            ...(input.phone === null ? { phoneVerifiedAt: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, id))
          .returning();
        if (u) user = u;
      }
      const [profile] = await tx
        .update(studentProfiles)
        .set({
          ...(input.institutionName !== undefined
            ? { institutionName: input.institutionName }
            : {}),
          ...(input.rollNumber !== undefined ? { rollNumber: input.rollNumber } : {}),
          ...(resolvedDepartmentId !== undefined ? { departmentId: resolvedDepartmentId } : {}),
          ...(input.programId !== undefined ? { programId: input.programId } : {}),
          ...(input.studyYear !== undefined ? { studyYear: input.studyYear } : {}),
          ...(input.program !== undefined ? { program: input.program } : {}),
          ...(input.graduationYear !== undefined ? { graduationYear: input.graduationYear } : {}),
          ...(input.collegeIdNumber !== undefined
            ? { collegeIdNumber: input.collegeIdNumber }
            : {}),
          profileVersion: row.profile.profileVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(studentProfiles.userId, id))
        .returning();
      if (audit)
        await insertAudit(tx, audit, {
          action: "FACULTY_STUDENT_PROFILE_CORRECTED",
          entityType: "user",
          entityId: id,
          before,
          after: { user: publicUser(user), profile },
        });
      return { user: publicUser(user), profile };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "Roll number already exists for this institution.");
    throw err;
  }
  return { before, after: result };
}
