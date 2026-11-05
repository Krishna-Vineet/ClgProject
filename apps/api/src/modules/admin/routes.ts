import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import {
  events,
  auditLogs,
  clubs,
  departments,
  jobRuns,
  notificationOutbox,
  programs,
  roleAssignments,
  users,
} from "../../db/schema";
import {
  authenticate,
  requireActiveAccount,
  requireRole,
  requireStaffDirectoryAdmin,
  staffDirectoryScope,
} from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

const { db } = getDb();

export const adminRoutes = new Hono();
adminRoutes.use("*", authenticate, requireActiveAccount, requireRole("ADMIN"));

adminRoutes.get("/setup", async (c) => {
  const [row] = await db
    .select({
      departments: sql<number>`(select count(*)::int from ${departments})`,
      programs: sql<number>`(select count(*)::int from ${programs})`,
      clubs: sql<number>`(select count(*)::int from ${clubs})`,
      events: sql<number>`(select count(*)::int from ${events})`,
      staff: sql<number>`count(distinct case when ${roleAssignments.role} in ('FACULTY','HOD_DEAN') then ${roleAssignments.userId} end)::int`,
      students: sql<number>`count(distinct case when ${users.accountType} = 'COLLEGE_STUDENT' and ${users.status} = 'ACTIVE' then ${users.id} end)::int`,
    })
    .from(users)
    .leftJoin(roleAssignments, eq(roleAssignments.userId, users.id));
  const counts = row ?? { departments: 0, programs: 0, clubs: 0, events: 0, staff: 0, students: 0 };
  const steps = [
    {
      id: "departments",
      label: "Create departments",
      done: counts.departments > 0,
      detail: `${counts.departments} department(s)`,
      href: "#/admin",
    },
    {
      id: "programmes",
      label: "Add student programmes",
      done: counts.programs > 0,
      detail: `${counts.programs} programme(s)`,
      href: "#/admin",
    },
    {
      id: "staff",
      label: "Provision HODs and faculty",
      done: counts.staff > 0,
      detail: `${counts.staff} staff member(s) with a role`,
      href: "#/admin",
    },
    {
      id: "clubs",
      label: "Create clubs and club teams",
      done: counts.clubs > 0,
      detail: `${counts.clubs} club(s)`,
      href: "#/clubs",
    },
    {
      id: "students",
      label: "Verify your first student",
      done: counts.students > 0,
      detail: `${counts.students} active student(s)`,
      href: "#/verification",
    },
    {
      id: "events",
      label: "Draft and publish an event",
      done: counts.events > 0,
      detail: `${counts.events} event(s)`,
      href: "#/events",
    },
  ];
  return ok(c, {
    counts,
    steps,
    complete: steps.every((step) => step.done),
    completedSteps: steps.filter((step) => step.done).length,
    totalSteps: steps.length,
  });
});

adminRoutes.get("/audit", async (c) => {
  const page = parseQuery(c, schemas.auditQuerySchema);
  const filters = [
    page.action ? eq(auditLogs.action, page.action) : undefined,
    page.entityType ? eq(auditLogs.entityType, page.entityType) : undefined,
  ].filter(Boolean);
  const rows = await db
    .select({
      log: auditLogs,
      actorName: users.fullName,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(page.limit + 1)
    .offset(page.offset);
  return ok(c, {
    items: rows.slice(0, page.limit).map((r) => ({
      id: r.log.id,
      action: r.log.action,
      entityType: r.log.entityType,
      entityId: r.log.entityId,
      eventId: r.log.eventId,
      before: r.log.beforeData,
      after: r.log.afterData,
      requestId: r.log.requestId,
      createdAt: r.log.createdAt,
      actor: r.actorName ? { fullName: r.actorName, email: r.actorEmail } : null,
    })),
    limit: page.limit,
    offset: page.offset,
    hasMore: rows.length > page.limit,
  });
});

adminRoutes.get("/users", async (c) =>
  ok(c, await service.listUsers(parseQuery(c, schemas.listUsersSchema))),
);

adminRoutes.get("/users/:id", async (c) => ok(c, await service.getUserDetail(c.req.param("id"))));

adminRoutes.post(
  "/staff",
  rateLimit({ windowMs: 60_000, max: 20, prefix: "provision-staff" }),
  async (c) => {
    const input = await parseJson(c, schemas.provisionStaffSchema);
    const result = await service.provisionStaff(input, auditContext(c));
    return ok(c, result, 201);
  },
);

adminRoutes.post("/users/:id/roles", async (c) => {
  const input = await parseJson(c, schemas.grantRoleSchema);
  const row = await service.grantRole(
    c.get("auth").user.id,
    c.req.param("id"),
    input,
    auditContext(c),
  );
  return ok(c, row, 201);
});

adminRoutes.delete("/users/:id/roles/:assignmentId", async (c) => {
  const row = await service.revokeRole(
    c.req.param("id"),
    c.req.param("assignmentId"),
    auditContext(c),
  );
  return ok(c, row);
});

adminRoutes.post("/users/:id/suspend", async (c) => {
  const input = await parseJson(c, schemas.suspendSchema);
  const result = await service.suspendUser(
    c.get("auth").user.id,
    c.req.param("id"),
    input,
    auditContext(c),
  );
  return ok(c, result);
});

adminRoutes.post("/users/:id/reactivate", async (c) => {
  const input = await parseJson(c, schemas.reactivateSchema);
  const result = await service.reactivateUser(c.req.param("id"), input, auditContext(c));
  return ok(c, result);
});

adminRoutes.post("/jobs/maintenance", async (c) => {
  const { runMaintenance } = await import("../../jobs/maintenance");
  return ok(c, await runMaintenance());
});

adminRoutes.get("/jobs", async (c) => {
  const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(20);
  const counts = await db
    .select({ status: notificationOutbox.status, n: count() })
    .from(notificationOutbox)
    .groupBy(notificationOutbox.status);
  const byStatus = new Map(counts.map((r) => [r.status, Number(r.n)]));
  return ok(c, {
    runs,
    outbox: {
      pending: byStatus.get("PENDING") ?? 0,
      failed: byStatus.get("FAILED") ?? 0,
      sent: byStatus.get("SENT") ?? 0,
      skipped: byStatus.get("SKIPPED") ?? 0,
    },
  });
});

/**
 * The staff directory, reachable by Admin and by an HOD/Dean scoped to their own
 * department. It is a separate Hono instance because `adminRoutes` carries a
 * blanket `requireRole("ADMIN")` guard; mounting this one first in app.ts lets
 * the narrower scope check apply instead. Every handler re-derives the scope from
 * the authenticated session, never from the request.
 */
export const staffDirectoryRoutes = new Hono();
staffDirectoryRoutes.use("*", authenticate, requireActiveAccount, requireStaffDirectoryAdmin);

/**
 * The staff directory. Admin sees the institution; an HOD/Dean sees the members
 * of their own department only. Both reach this route, so the check is a scope
 * check rather than `requireRole("ADMIN")`.
 */
staffDirectoryRoutes.get("/staff", requireStaffDirectoryAdmin, async (c) =>
  ok(
    c,
    await service.listStaffForScope(
      staffDirectoryScope(c.get("auth")),
      parseQuery(c, schemas.listStaffSchema),
    ),
  ),
);

/** Programmes the caller may administer, already narrowed to their scope. */
staffDirectoryRoutes.get("/programs", requireStaffDirectoryAdmin, async (c) =>
  ok(c, {
    items: await service.listProgramsForScope(staffDirectoryScope(c.get("auth"))),
  }),
);

/** Edit a staff member's details. HOD/Dean: contact fields in their department only. */
staffDirectoryRoutes.patch("/staff/:id", requireStaffDirectoryAdmin, async (c) => {
  const scope = staffDirectoryScope(c.get("auth"));
  const input =
    scope === null
      ? await parseJson(c, schemas.updateStaffSchema)
      : await parseJson(c, schemas.updateStaffContactSchema);
  const actor = c.get("auth").user.id;
  return ok(
    c,
    await service.updateStaffMember(actor, c.req.param("id"), input, scope, auditContext(c)),
  );
});
