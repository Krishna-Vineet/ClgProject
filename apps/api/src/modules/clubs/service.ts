import { and, eq, ilike, inArray, ne, or } from "drizzle-orm";
import type { z } from "zod";
import { getDb } from "../../db/client";
import { clubMemberships, clubs, roleAssignments, users } from "../../db/schema";
import { type AuthContext, departmentScope, hasRole } from "../../middleware/auth";
import { departmentOwner } from "../../middleware/club-scope";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { type AuditContext, insertAudit } from "../audit/service";
import type {
  addMemberSchema,
  createClubSchema,
  updateClubSchema,
  updateMemberSchema,
} from "./schemas";

/** Only Admin, or HOD/Dean for the club's own department, may touch faculty. */
function assertMayManageFaculty(auth: AuthContext, clubDepartmentId: string | null) {
  if (hasRole(auth, "ADMIN") || departmentOwner(auth, clubDepartmentId)) return;
  throw new ApiError(
    "FORBIDDEN",
    "Only HOD/Dean of the department or the administrator can add or remove club faculty.",
  );
}

/** A club must keep at least one active lead, or nobody can run it. */
async function assertNotLastLead(clubId: string, membershipId: string) {
  const { db } = getDb();
  const leads = await db
    .select({ id: clubMemberships.id })
    .from(clubMemberships)
    .where(
      and(
        eq(clubMemberships.clubId, clubId),
        eq(clubMemberships.clubRole, "LEAD"),
        eq(clubMemberships.isActive, true),
      ),
    );
  if (leads.length <= 1 && leads.some((l) => l.id === membershipId))
    throw new ApiError("CONFLICT", "Promote another lead before removing the last one.");
}

/**
 * The roles whose holder may act as a club's faculty.
 *
 * Faculty approve directly; HOD/Dean approve within their department and Admin
 * institution-wide, and all three are staff who can scan and open exceptions.
 * Keeping this list in one place is what stopped the picker and the permission
 * check from disagreeing.
 */
const FACULTY_ELIGIBLE_ROLES = ["FACULTY", "HOD_DEAN", "ADMIN"] as const;

async function assertIsFacultyAccount(userId: string, clubDepartmentId: string | null) {
  const { db } = getDb();
  const rows = await db
    .select({
      role: roleAssignments.role,
      scopeType: roleAssignments.scopeType,
      departmentId: roleAssignments.departmentId,
    })
    .from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .where(
      and(
        eq(users.id, userId),
        eq(users.accountType, "STAFF"),
        eq(roleAssignments.isActive, true),
        inArray(roleAssignments.role, [...FACULTY_ELIGIBLE_ROLES]),
      ),
    );
  const ok = rows.some(
    (r) =>
      r.role === "FACULTY" ||
      r.role === "ADMIN" ||
      (r.role === "HOD_DEAN" &&
        (r.scopeType === "GLOBAL" ||
          (clubDepartmentId !== null && r.departmentId === clubDepartmentId))),
  );
  if (!ok)
    throw new ApiError(
      "VALIDATION_ERROR",
      "Club faculty must be an active staff member who can approve this club's events (faculty, the department's HOD/Dean, or an admin).",
    );
}

export async function listClubs(
  auth: AuthContext,
  page: { limit: number; offset: number } = { limit: 25, offset: 0 },
) {
  const { db } = getDb();
  const admin = hasRole(auth, "ADMIN");
  const senior = departmentScope(auth, "HOD_DEAN");
  const memberClubIds = auth.memberships.map((m) => m.clubId);
  if (!admin && !senior.global) {
    const scopeParts = [];
    if (senior.departmentIds.length)
      scopeParts.push(inArray(clubs.departmentId, senior.departmentIds));
    if (memberClubIds.length) scopeParts.push(inArray(clubs.id, memberClubIds));
    if (scopeParts.length === 0)
      return { items: [], hasMore: false, limit: page.limit, offset: page.offset };
    const rows = await db
      .select()
      .from(clubs)
      .where(and(eq(clubs.isActive, true), or(...scopeParts)))
      .orderBy(clubs.name)
      .limit(page.limit + 1)
      .offset(page.offset);
    return {
      items: rows.slice(0, page.limit),
      hasMore: rows.length > page.limit,
      limit: page.limit,
      offset: page.offset,
    };
  }
  const rows = await db
    .select()
    .from(clubs)
    .where(eq(clubs.isActive, true))
    .orderBy(clubs.name)
    .limit(page.limit + 1)
    .offset(page.offset);
  return {
    items: rows.slice(0, page.limit),
    hasMore: rows.length > page.limit,
    limit: page.limit,
    offset: page.offset,
  };
}

export async function createClub(
  actorId: string,
  input: z.infer<typeof createClubSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(clubs)
        .values({
          ...input,
          departmentId: input.departmentId ?? null,
          createdBy: actorId,
        })
        .returning();
      if (audit)
        await insertAudit(tx, audit, {
          action: "CLUB_CREATED",
          entityType: "club",
          entityId: row?.id,
          after: input,
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError("CONFLICT", "Club name or slug already exists.");
    throw err;
  }
}

export async function updateClub(
  clubId: string,
  input: z.infer<typeof updateClubSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(clubs)
        .set({ ...input })
        .where(eq(clubs.id, clubId))
        .returning();
      if (!row) throw new ApiError("NOT_FOUND", "Club not found.");
      if (audit)
        await insertAudit(tx, audit, {
          action: "CLUB_UPDATED",
          entityType: "club",
          entityId: clubId,
          after: input,
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError("CONFLICT", "Club name or slug already exists.");
    throw err;
  }
}

/** Same rule as requireClubManage, without throwing. */
export function canManageClub(
  auth: AuthContext,
  club: { id: string; departmentId: string | null },
): boolean {
  const isLead = auth.memberships.some(
    (m) => m.clubId === club.id && m.clubRole === "LEAD" && m.isActive,
  );
  return hasRole(auth, "ADMIN") || isLead || departmentOwner(auth, club.departmentId);
}

export async function listMembers(clubId: string) {
  const { db } = getDb();
  return db
    .select({
      membership: clubMemberships,
      user: {
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        accountType: users.accountType,
        status: users.status,
      },
    })
    .from(clubMemberships)
    .innerJoin(users, eq(users.id, clubMemberships.userId))
    .where(eq(clubMemberships.clubId, clubId));
}

/**
 * Find accounts a club manager may add as a coordinator. Deliberately narrow:
 * active accounts only, outsiders excluded (they cannot be coordinators), and
 * only id/name/email returned. Requires a query of at least two characters.
 */
export async function findMemberCandidates(input: {
  q: string;
  limit: number;
  role?: "LEAD" | "COORDINATOR" | "FACULTY" | undefined;
}) {
  const { db } = getDb();
  const pattern = `%${input.q}%`;
  if (input.role === "FACULTY") {
    /*
     * Who may be a club's faculty?
     *
     * Anyone who is a member of staff and is allowed to approve that club's
     * events — which is not the same as "holds the FACULTY role". An HOD/Dean
     * and an Admin both approve; both were being filtered out of this picker,
     * so the screen said "no matching faculty" while the person sat right there
     * in the staff directory. The permission check (`assertIsFacultyAccount`)
     * already accepts a staff approver, so the picker now matches it.
     */
    const staff = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        accountType: users.accountType,
        role: roleAssignments.role,
        scopeType: roleAssignments.scopeType,
        departmentId: roleAssignments.departmentId,
      })
      .from(users)
      .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
      .where(
        and(
          eq(users.status, "ACTIVE"),
          eq(users.accountType, "STAFF"),
          eq(roleAssignments.isActive, true),
          inArray(roleAssignments.role, [...FACULTY_ELIGIBLE_ROLES]),
          or(ilike(users.email, pattern), ilike(users.fullName, pattern)),
        ),
      )
      .orderBy(users.fullName)
      .limit(input.limit * 4);
    // A person can hold several assignments; offer them once, and only if at
    // least one of them actually covers the authority to approve.
    const byId = new Map<
      string,
      { id: string; fullName: string; email: string; accountType: string }
    >();
    for (const r of staff) {
      const covers =
        r.role === "ADMIN" ||
        r.role === "FACULTY" ||
        r.scopeType === "GLOBAL" ||
        (r.role === "HOD_DEAN" && r.departmentId !== null);
      if (covers && !byId.has(r.id))
        byId.set(r.id, {
          id: r.id,
          fullName: r.fullName,
          email: r.email,
          accountType: r.accountType,
        });
    }
    return { items: [...byId.values()].slice(0, input.limit) };
  }
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      accountType: users.accountType,
    })
    .from(users)
    .where(
      and(
        eq(users.status, "ACTIVE"),
        ne(users.accountType, "OUTSIDER_STUDENT"),
        or(ilike(users.email, pattern), ilike(users.fullName, pattern)),
      ),
    )
    .orderBy(users.fullName)
    .limit(input.limit);
  return { items: rows };
}

export async function addMember(
  auth: AuthContext,
  clubId: string,
  input: z.infer<typeof addMemberSchema>,
  audit?: AuditContext,
) {
  const actorId = auth.user.id;
  const { db } = getDb();
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
  if (!club) throw new ApiError("NOT_FOUND", "Club not found.");
  if (input.clubRole === "FACULTY") {
    assertMayManageFaculty(auth, club.departmentId);
    await assertIsFacultyAccount(input.userId, club.departmentId);
  }
  const [target] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!target) throw new ApiError("NOT_FOUND", "User not found.");
  if (target.status !== "ACTIVE") throw new ApiError("CONFLICT", "User must be active.");
  if (target.accountType === "OUTSIDER_STUDENT")
    throw new ApiError("FORBIDDEN", "Outsider students cannot be club coordinators.");
  const [existing] = await db
    .select()
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, input.userId)))
    .limit(1);
  if (existing?.isActive) throw new ApiError("CONFLICT", "User is already a member of this club.");
  try {
    return await db.transaction(async (tx) => {
      let row: typeof clubMemberships.$inferSelect | undefined;
      if (existing) {
        [row] = await tx
          .update(clubMemberships)
          .set({ isActive: true, clubRole: input.clubRole, addedBy: actorId })
          .where(eq(clubMemberships.id, existing.id))
          .returning();
      } else {
        [row] = await tx
          .insert(clubMemberships)
          .values({ clubId, userId: input.userId, clubRole: input.clubRole, addedBy: actorId })
          .returning();
      }
      if (audit)
        await insertAudit(tx, audit, {
          action: "CLUB_MEMBER_ADDED",
          entityType: "club_membership",
          entityId: row?.id,
          clubId,
          after: input,
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "User is already a member of this club.");
    throw err;
  }
}

export async function updateMember(
  auth: AuthContext,
  clubId: string,
  membershipId: string,
  input: z.infer<typeof updateMemberSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
  if (!club) throw new ApiError("NOT_FOUND", "Club not found.");
  const [row] = await db
    .select()
    .from(clubMemberships)
    .where(and(eq(clubMemberships.id, membershipId), eq(clubMemberships.clubId, clubId)))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Membership not found.");
  // Moving into or out of the faculty role, or disabling a faculty member, is an
  // institutional decision, not a club-lead one.
  if (row.clubRole === "FACULTY" || input.clubRole === "FACULTY")
    assertMayManageFaculty(auth, club.departmentId);
  if (input.clubRole === "FACULTY") await assertIsFacultyAccount(row.userId, club.departmentId);
  if (row.clubRole === "LEAD" && (input.clubRole === "COORDINATOR" || input.isActive === false))
    await assertNotLastLead(clubId, membershipId);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(clubMemberships)
      .set({ ...input })
      .where(eq(clubMemberships.id, membershipId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: input.isActive === false ? "CLUB_MEMBER_REMOVED" : "CLUB_MEMBER_UPDATED",
        entityType: "club_membership",
        entityId: membershipId,
        clubId,
        before: row,
        after: input,
      });
    return updated;
  });
}

export async function removeMember(
  auth: AuthContext,
  clubId: string,
  membershipId: string,
  audit?: AuditContext,
) {
  return updateMember(auth, clubId, membershipId, { isActive: false }, audit);
}

export async function myClubs(auth: AuthContext) {
  const { db } = getDb();
  const ids = auth.memberships.map((m) => m.clubId);
  if (ids.length === 0) return [];
  return db
    .select({ club: clubs, membership: clubMemberships })
    .from(clubMemberships)
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .where(and(eq(clubMemberships.userId, auth.user.id), eq(clubMemberships.isActive, true)));
}
