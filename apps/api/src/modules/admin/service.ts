import { STAFF_POSITION_LABELS, inferStaffPosition } from "@campusops/shared";
import { type SQL, and, count, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDb } from "../../db/client";
import {
  clubMemberships,
  clubs,
  departments,
  roleAssignments,
  sessions,
  staffProfiles,
  studentProfiles,
  users,
} from "../../db/schema";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { publicUser } from "../auth/service";
import type {
  grantRoleSchema,
  listStaffSchema,
  listUsersSchema,
  provisionStaffSchema,
  reactivateSchema,
  suspendSchema,
} from "./schemas";

export async function listStaff(input: z.infer<typeof listStaffSchema>) {
  const { db } = getDb();
  const filters: SQL[] = [eq(users.accountType, "STAFF")];
  if (input.status) filters.push(eq(users.status, input.status));
  if (input.departmentId) filters.push(eq(staffProfiles.departmentId, input.departmentId));
  if (input.position) filters.push(eq(staffProfiles.position, input.position));
  if (input.q) {
    const q = or(
      ilike(users.email, `%${input.q}%`),
      ilike(users.fullName, `%${input.q}%`),
      ilike(users.phone ?? users.email, `%${input.q}%`),
    );
    if (q) filters.push(q);
  }
  const where = and(...filters);
  const rows = await db
    .select({
      user: users,
      staff: staffProfiles,
      departmentName: departments.name,
    })
    .from(users)
    .innerJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .where(where)
    .orderBy(users.fullName, users.id)
    .limit(input.limit + 1)
    .offset(input.offset);
  const [totalRow] = await db
    .select({ n: count() })
    .from(users)
    .innerJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(where);
  const pageRows = rows.slice(0, input.limit);
  const roleRows = pageRows.length
    ? await db
        .select({ userId: roleAssignments.userId, role: roleAssignments.role })
        .from(roleAssignments)
        .where(
          and(
            inArray(
              roleAssignments.userId,
              pageRows.map((r) => r.user.id),
            ),
            eq(roleAssignments.isActive, true),
          ),
        )
    : [];
  return {
    items: pageRows.map((r) => ({
      ...publicUser(r.user),
      phone: r.user.phone,
      departmentId: r.staff.departmentId,
      departmentName: r.departmentName,
      designation: r.staff.designation,
      position: r.staff.position,
      roles: roleRows.filter((x) => x.userId === r.user.id).map((x) => x.role),
    })),
    total: totalRow?.n ?? 0,
    limit: input.limit,
    offset: input.offset,
    hasMore: rows.length > input.limit,
  };
}

export async function listUsers(input: z.infer<typeof listUsersSchema>) {
  const { db } = getDb();
  const filters: SQL[] = [];
  if (input.status) filters.push(eq(users.status, input.status));
  if (input.q) {
    const q = or(ilike(users.email, `%${input.q}%`), ilike(users.fullName, `%${input.q}%`));
    if (q) filters.push(q);
  }
  const where = filters.length ? and(...filters) : undefined;
  const items = await db
    .select()
    .from(users)
    .where(where)
    .limit(input.limit)
    .offset(input.offset)
    .orderBy(users.createdAt);
  const [totalRow] = await db.select({ n: count() }).from(users).where(where);
  return {
    items: items.map(publicUser),
    total: totalRow?.n ?? 0,
    limit: input.limit,
    offset: input.offset,
  };
}

/**
 * Everything the admin console needs about one account: profile, current role
 * assignments (with the ids required to revoke them) and club memberships.
 * Without this the UI could grant roles but never show or remove existing ones.
 */
export async function getUserDetail(userId: string) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError("NOT_FOUND", "User not found.");
  const [staff] = await db
    .select()
    .from(staffProfiles)
    .where(eq(staffProfiles.userId, userId))
    .limit(1);
  const [student] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, userId))
    .limit(1);
  const roles = await db
    .select()
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId))
    .orderBy(roleAssignments.createdAt);
  const memberships = await db
    .select({
      id: clubMemberships.id,
      clubId: clubMemberships.clubId,
      clubName: clubs.name,
      clubRole: clubMemberships.clubRole,
      isActive: clubMemberships.isActive,
    })
    .from(clubMemberships)
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .where(eq(clubMemberships.userId, userId));
  return {
    user: publicUser(user),
    staffProfile: staff ?? null,
    studentProfile: student ?? null,
    roles,
    clubMemberships: memberships,
  };
}

export async function provisionStaff(
  input: z.infer<typeof provisionStaffSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const position = input.position ?? inferStaffPosition(input.designation);
  const designation = input.designation ?? STAFF_POSITION_LABELS[position];
  try {
    const user = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash: "STAFF_SETUP_PENDING",
          accountType: "STAFF",
          status: "PENDING_EMAIL",
          fullName: input.fullName,
          phone: input.phone ?? null,
        })
        .returning();
      if (!u) throw new ApiError("INTERNAL_ERROR", "Staff creation failed.");
      await tx.insert(staffProfiles).values({
        userId: u.id,
        employeeCode: input.employeeCode ?? null,
        departmentId: input.departmentId ?? null,
        designation,
        position,
      });
      if (audit)
        await insertAudit(tx, audit, {
          action: "ADMIN_STAFF_PROVISIONED",
          entityType: "user",
          entityId: u.id,
          after: {
            email: u.email,
            designation,
            position,
            departmentId: input.departmentId ?? null,
          },
        });
      return u;
    });
    // Provisioning does not issue or reveal a setup OTP. Staff begin setup by
    // requesting a password reset themselves; that flow creates STAFF_SETUP OTP.
    return { user: publicUser(user) };
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("EMAIL_EXISTS", "An account with this email already exists.");
    throw err;
  }
}

export async function grantRole(
  actorId: string,
  userId: string,
  input: z.infer<typeof grantRoleSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) throw new ApiError("NOT_FOUND", "User not found.");
  if (target.accountType !== "STAFF") {
    throw new ApiError("INVALID_ROLE_SCOPE", "Global roles require a staff account.");
  }
  const departmentId = input.scopeType === "DEPARTMENT" ? (input.departmentId ?? null) : null;
  const [existing] = await db
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.userId, userId),
        eq(roleAssignments.role, input.role),
        eq(roleAssignments.scopeType, input.scopeType),
        departmentId
          ? eq(roleAssignments.departmentId, departmentId)
          : isNull(roleAssignments.departmentId),
      ),
    )
    .limit(1);
  if (existing?.isActive) throw new ApiError("CONFLICT", "Role assignment already exists.");
  try {
    return await db.transaction(async (tx) => {
      let row: typeof roleAssignments.$inferSelect | undefined;
      if (existing) {
        [row] = await tx
          .update(roleAssignments)
          .set({ isActive: true, grantedBy: actorId })
          .where(eq(roleAssignments.id, existing.id))
          .returning();
      } else {
        [row] = await tx
          .insert(roleAssignments)
          .values({
            userId,
            role: input.role,
            scopeType: input.scopeType,
            departmentId,
            grantedBy: actorId,
          })
          .returning();
      }
      if (audit)
        await insertAudit(tx, audit, {
          action: "ADMIN_ROLE_GRANTED",
          entityType: "role_assignment",
          entityId: row?.id,
          after: input,
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError("CONFLICT", "Role assignment already exists.");
    throw err;
  }
}

export async function revokeRole(userId: string, assignmentId: string, audit?: AuditContext) {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(roleAssignments)
    .where(and(eq(roleAssignments.id, assignmentId), eq(roleAssignments.userId, userId)))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Role assignment not found.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('campusops:last-admin'))`);
    if (row.role === "ADMIN") {
      const [admins] = await tx
        .select({ n: count() })
        .from(roleAssignments)
        .where(and(eq(roleAssignments.role, "ADMIN"), eq(roleAssignments.isActive, true)));
      if ((admins?.n ?? 0) <= 1)
        throw new ApiError("LAST_ADMIN", "Cannot revoke the last active admin.");
    }
    const [updated] = await tx
      .update(roleAssignments)
      .set({ isActive: false })
      .where(eq(roleAssignments.id, assignmentId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "ADMIN_ROLE_REVOKED",
        entityType: "role_assignment",
        entityId: assignmentId,
        before: row,
      });
    return updated;
  });
}

export async function suspendUser(
  actorId: string,
  userId: string,
  input: z.infer<typeof suspendSchema>,
  audit?: AuditContext,
) {
  if (actorId === userId) {
    throw new ApiError("FORBIDDEN", "You cannot suspend your own account.");
  }
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError("NOT_FOUND", "User not found.");
  const [adminRole] = await db
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.userId, userId),
        eq(roleAssignments.role, "ADMIN"),
        eq(roleAssignments.isActive, true),
      ),
    )
    .limit(1);
  const [updated] = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('campusops:last-admin'))`);
    if (adminRole) {
      const [admins] = await tx
        .select({ n: count() })
        .from(roleAssignments)
        .where(and(eq(roleAssignments.role, "ADMIN"), eq(roleAssignments.isActive, true)));
      if ((admins?.n ?? 0) <= 1)
        throw new ApiError("LAST_ADMIN", "Cannot suspend the last active admin.");
    }
    const [u] = await tx
      .update(users)
      .set({ status: "SUSPENDED", updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    if (audit)
      await insertAudit(tx, audit, {
        action: "ADMIN_USER_SUSPENDED",
        entityType: "user",
        entityId: userId,
        after: { reason: input.reason },
      });
    return [u];
  });
  return { user: updated ? publicUser(updated) : null, reason: input.reason };
}

export async function reactivateUser(
  userId: string,
  input: z.infer<typeof reactivateSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError("NOT_FOUND", "User not found.");
  if (user.status !== "SUSPENDED")
    throw new ApiError("CONFLICT", "Only suspended accounts can be reactivated.");
  let nextStatus: typeof users.$inferSelect.status = "ACTIVE";
  if (!user.emailVerifiedAt) nextStatus = "PENDING_EMAIL";
  if (user.accountType === "COLLEGE_STUDENT") {
    const [profile] = await db
      .select()
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, userId))
      .limit(1);
    if (!profile?.verifiedAt) nextStatus = "PENDING_VERIFICATION";
  }
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(users)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "ADMIN_USER_REACTIVATED",
        entityType: "user",
        entityId: userId,
        after: { reason: input.reason, status: u?.status },
      });
    return u;
  });
  return { user: updated ? publicUser(updated) : null, reason: input.reason };
}
