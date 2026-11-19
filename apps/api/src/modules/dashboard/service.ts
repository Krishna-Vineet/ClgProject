import { type SQL, and, count, eq, gte, inArray, or, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { getDb } from "../../db/client";
import {
  events,
  clubs,
  complaints,
  registrationHistory,
  registrations,
  resourceReservations,
  studentProfiles,
  users,
} from "../../db/schema";
import { type AuthContext, departmentScope, hasRole } from "../../middleware/auth";
import { inbox } from "../approvals/service";

/**
 * Role-scoped management dashboard. Every number is computed from rows the
 * caller is allowed to manage/oversee; nothing is sampled or estimated.
 * Coordinators see their clubs; HOD/Dean their departments; Admin everything.
 * Faculty see their club work plus their own approval/verification workload.
 */
export async function dashboard(auth: AuthContext) {
  const { db } = getDb();
  const now = new Date();
  // Day buckets must follow the campus calendar, not the DB server's UTC clock:
  // an 00:30 IST confirmation belongs to the IST day, not the previous UTC day.
  const tz = env.CAMPUS_TIMEZONE;
  const campusDay = sql`date_trunc('day', ${registrationHistory.createdAt} AT TIME ZONE ${tz})`;
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const admin = hasRole(auth, "ADMIN");
  const senior = departmentScope(auth, "HOD_DEAN");
  const clubIds = auth.memberships.map((m) => m.clubId);
  const organiserClubIds = auth.memberships
    .filter((m) => m.clubRole !== "FACULTY")
    .map((m) => m.clubId);

  // Event scope: management rows, not the public feed.
  const scopeParts: SQL[] = [];
  if (admin) scopeParts.push(sql`true`);
  if (senior.global) scopeParts.push(sql`true`);
  else if (senior.departmentIds.length)
    scopeParts.push(inArray(clubs.departmentId, senior.departmentIds));
  if (clubIds.length) scopeParts.push(inArray(events.clubId, clubIds));
  const eventScope = scopeParts.length ? or(...scopeParts) : sql`false`;

  const [eventRows, regRows, complaintRows, holdRows, upcoming, trend, approvals] =
    await Promise.all([
      db
        .select({ status: events.status, n: count() })
        .from(events)
        .innerJoin(clubs, eq(clubs.id, events.clubId))
        .where(eventScope)
        .groupBy(events.status),
      db
        .select({ status: registrations.status, n: count() })
        .from(registrations)
        .innerJoin(events, eq(events.id, registrations.eventId))
        .innerJoin(clubs, eq(clubs.id, events.clubId))
        .where(eventScope)
        .groupBy(registrations.status),
      // Complaint inboxes are organiser-only, so faculty-only accounts get 0.
      db
        .select({ n: count() })
        .from(complaints)
        .innerJoin(events, eq(events.id, complaints.eventId))
        .innerJoin(clubs, eq(clubs.id, events.clubId))
        .where(
          and(
            inArray(complaints.status, ["OPEN", "ASSIGNED"]),
            admin || senior.global
              ? sql`true`
              : or(
                  senior.departmentIds.length
                    ? inArray(clubs.departmentId, senior.departmentIds)
                    : sql`false`,
                  organiserClubIds.length ? inArray(events.clubId, organiserClubIds) : sql`false`,
                ),
          ),
        ),
      db
        .select({ n: count() })
        .from(resourceReservations)
        .innerJoin(events, eq(events.id, resourceReservations.eventId))
        .innerJoin(clubs, eq(clubs.id, events.clubId))
        .where(and(eq(resourceReservations.status, "HELD"), eventScope)),
      db
        .select({
          id: events.id,
          title: events.title,
          status: events.status,
          startsAt: events.startsAt,
          endsAt: events.endsAt,
          venueSummary: events.venueSummary,
          capacity: events.capacity,
          clubName: clubs.name,
          confirmed: sql<number>`(select count(*)::int from registrations r where r.event_id = ${events.id} and r.status = 'CONFIRMED')`,
        })
        .from(events)
        .innerJoin(clubs, eq(clubs.id, events.clubId))
        .where(
          and(
            eventScope,
            gte(events.endsAt, now),
            inArray(events.status, ["PUBLISHED", "LIVE", "READY", "PENDING_APPROVALS"]),
          ),
        )
        .orderBy(events.startsAt)
        .limit(6),
      db
        .select({
          day: sql<string>`to_char(${campusDay}, 'YYYY-MM-DD')`,
          n: count(),
        })
        .from(registrationHistory)
        .innerJoin(registrations, eq(registrations.id, registrationHistory.registrationId))
        .innerJoin(events, eq(events.id, registrations.eventId))
        .innerJoin(clubs, eq(clubs.id, events.clubId))
        .where(
          and(
            eventScope,
            eq(registrationHistory.toStatus, "CONFIRMED"),
            sql`${campusDay} >= (date_trunc('day', now() AT TIME ZONE ${tz}) - interval '13 days')`,
          ),
        )
        // Group/order by output column 1: repeating the expression would send a
        // second bound parameter and Postgres would not match it to the select.
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      inbox(auth, { limit: 4, offset: 0, scope: "all" }),
    ]);

  const byStatus = new Map(eventRows.map((r) => [r.status, Number(r.n)]));
  const regBy = new Map(regRows.map((r) => [r.status, Number(r.n)]));
  const sum = (...keys: Array<typeof events.$inferSelect.status>) =>
    keys.reduce((a, k) => a + (byStatus.get(k) ?? 0), 0);

  // Only a FACULTY holder can verify a student, so only a FACULTY holder is told
  // there is verifying to do. An HOD counting an unreadable queue is a task
  // they cannot complete.
  let verificationPending = 0;
  if (hasRole(auth, "FACULTY")) {
    const fac = departmentScope(auth, "FACULTY");
    const parts: SQL[] = [];
    if (fac.global) parts.push(sql`true`);
    if (fac.departmentIds.length)
      parts.push(inArray(studentProfiles.departmentId, fac.departmentIds));
    if (parts.length) {
      const [row] = await db
        .select({ n: count() })
        .from(users)
        .innerJoin(studentProfiles, eq(studentProfiles.userId, users.id))
        .where(
          and(
            eq(users.status, "PENDING_VERIFICATION"),
            eq(users.accountType, "COLLEGE_STUDENT"),
            or(...parts),
          ),
        );
      verificationPending = Number(row?.n ?? 0);
    }
  }

  const days: Array<{ day: string; confirmed: number }> = [];
  const trendBy = new Map(trend.map((t) => [t.day, Number(t.n)]));
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    const key = dayKey.format(d);
    days.push({ day: key, confirmed: trendBy.get(key) ?? 0 });
  }

  return {
    generatedAt: now.toISOString(),
    scope:
      admin || senior.global
        ? "INSTITUTION"
        : senior.departmentIds.length
          ? "DEPARTMENT"
          : clubIds.length
            ? "CLUBS"
            : "PERSONAL",
    events: {
      total: sum(
        "DRAFT",
        "PENDING_APPROVALS",
        "READY",
        "PUBLISHED",
        "LIVE",
        "COMPLETED",
        "CANCELLED",
      ),
      live: byStatus.get("LIVE") ?? 0,
      upcoming: sum("READY", "PUBLISHED"),
      draft: byStatus.get("DRAFT") ?? 0,
      pendingApprovals: byStatus.get("PENDING_APPROVALS") ?? 0,
      completed: byStatus.get("COMPLETED") ?? 0,
    },
    registrations: {
      confirmed: regBy.get("CONFIRMED") ?? 0,
      waitlisted: regBy.get("WAITLISTED") ?? 0,
      applied: regBy.get("APPLIED") ?? 0,
    },
    work: {
      approvalsPending: approvals.total ?? 0,
      verificationPending,
      openComplaints: Number(complaintRows[0]?.n ?? 0),
      resourceHolds: Number(holdRows[0]?.n ?? 0),
    },
    upcoming: upcoming.map((e) => ({ ...e, confirmed: Number(e.confirmed) })),
    confirmationTrend: days,
    approvalQueue: approvals.items,
  };
}
