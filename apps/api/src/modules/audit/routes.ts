import { offsetPaginationSchema } from "@campusops/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "../../db/client";
import { auditLogs, users } from "../../db/schema";
import { hasRole } from "../../middleware/auth";
import { parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";

const auditQuerySchema = offsetPaginationSchema.extend({
  action: z.string().trim().max(80).optional(),
});

/**
 * Scoped audit history for one event.
 *
 * This is a handler, not a router: mounting a router at `/api/v1` would apply its
 * wildcard auth middleware to every API path (including unknown ones), which
 * turns 404s into 401s. `eventRoutes` registers this behind its own auth and
 * `requireEventOperationalRead()` instead.
 *
 * Audit rows are append-only and redacted at write time; this reader only
 * narrows who may see them.
 */
export async function eventAuditHandler(c: Context) {
  const auth = c.get("auth");
  const event = c.get("event");
  const club = c.get("eventClub");
  const page = parseQuery(c, auditQuerySchema);
  const { db } = getDb();

  // Faculty may read approval history for the event, not unrelated club admin actions.
  const facultyOnly =
    hasRole(auth, "FACULTY") &&
    !hasRole(auth, "ADMIN") &&
    !hasRole(auth, "HOD_DEAN") &&
    !auth.memberships.some((m) => m.clubId === event.clubId);

  const filters = [eq(auditLogs.eventId, event.id)];
  if (page.action) filters.push(eq(auditLogs.action, page.action));
  if (facultyOnly) filters.push(eq(auditLogs.entityType, "approval_request"));

  const rows = await db
    .select({
      log: auditLogs,
      actor: { id: users.id, fullName: users.fullName },
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(and(...filters))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(page.limit + 1)
    .offset(page.offset);

  return ok(c, {
    items: rows.slice(0, page.limit).map((r) => ({
      id: r.log.id,
      action: r.log.action,
      entityType: r.log.entityType,
      entityId: r.log.entityId,
      actor: r.actor,
      before: r.log.beforeData,
      after: r.log.afterData,
      requestId: r.log.requestId,
      createdAt: r.log.createdAt,
    })),
    limit: page.limit,
    offset: page.offset,
    hasMore: rows.length > page.limit,
  });
}
