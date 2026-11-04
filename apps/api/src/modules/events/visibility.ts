import { type SQL, and, asc, eq, gt, gte, ilike, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../../db/client";
import { events, eventInvitations } from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { hasRole } from "../../middleware/auth";
import { ApiError } from "../../utils/api-error";

const PUBLIC_STATUSES = ["PUBLISHED", "LIVE", "COMPLETED"] as const;

export type VisibleEventQuery = {
  limit: number;
  offset: number;
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: string | undefined;
};

/**
 * The same visibility rule as listVisibleEvents, expressed as a SQL predicate.
 *
 * Callers that need to join events to something else (the announcement inbox,
 * for example) must filter in the database. Fetching "the first N visible
 * events" and filtering in memory silently drops recent rows once a campus has
 * more than N events, which is exactly when announcements matter most.
 */
export async function visibleEventPredicate(auth: AuthContext): Promise<SQL | undefined> {
  const { db } = getDb();
  const invited = await db
    .select({ eventId: eventInvitations.eventId })
    .from(eventInvitations)
    .where(
      and(
        eq(eventInvitations.email, auth.user.email),
        isNull(eventInvitations.revokedAt),
        or(isNull(eventInvitations.expiresAt), gt(eventInvitations.expiresAt, new Date())),
      ),
    );
  const invitedIds = invited.map((i) => i.eventId);
  const oversight = hasRole(auth, "ADMIN") || hasRole(auth, "HOD_DEAN") || hasRole(auth, "FACULTY");
  const memberClubIds = auth.memberships.map((m) => m.clubId);
  const publicStatus = inArray(events.status, [...PUBLIC_STATUSES]);
  const audience: SQL[] = [eq(events.audience, "OUTSIDERS_ALLOWED")];
  if (auth.user.accountType !== "OUTSIDER_STUDENT")
    audience.push(eq(events.audience, "COLLEGE_ONLY"));
  if (invitedIds.length)
    audience.push(and(eq(events.audience, "INVITED_ONLY"), inArray(events.id, invitedIds)) as SQL);
  if (oversight)
    return or(
      publicStatus,
      memberClubIds.length ? inArray(events.clubId, memberClubIds) : undefined,
    );
  if (memberClubIds.length)
    return or(and(publicStatus, or(...audience)), inArray(events.clubId, memberClubIds));
  return and(publicStatus, or(...audience));
}

export async function listVisibleEvents(
  auth: AuthContext,
  page: VisibleEventQuery = { limit: 25, offset: 0 },
) {
  const { db } = getDb();
  const invited = await db
    .select({ eventId: eventInvitations.eventId })
    .from(eventInvitations)
    .where(
      and(
        eq(eventInvitations.email, auth.user.email),
        isNull(eventInvitations.revokedAt),
        or(isNull(eventInvitations.expiresAt), gt(eventInvitations.expiresAt, new Date())),
      ),
    );
  const invitedIds = invited.map((i) => i.eventId);
  const oversight = hasRole(auth, "ADMIN") || hasRole(auth, "HOD_DEAN") || hasRole(auth, "FACULTY");
  const memberClubIds = auth.memberships.map((m) => m.clubId);
  const publicStatus = inArray(events.status, [...PUBLIC_STATUSES]);
  const audience: SQL[] = [eq(events.audience, "OUTSIDERS_ALLOWED")];
  if (auth.user.accountType !== "OUTSIDER_STUDENT")
    audience.push(eq(events.audience, "COLLEGE_ONLY"));
  if (invitedIds.length)
    audience.push(and(eq(events.audience, "INVITED_ONLY"), inArray(events.id, invitedIds)) as SQL);
  let where: SQL | undefined;
  if (oversight) {
    where = or(
      publicStatus,
      memberClubIds.length ? inArray(events.clubId, memberClubIds) : undefined,
    );
  } else if (memberClubIds.length) {
    where = or(and(publicStatus, or(...audience)), inArray(events.clubId, memberClubIds));
  } else {
    where = and(publicStatus, or(...audience));
  }
  const extra: SQL[] = [];
  if (page.q) extra.push(ilike(events.title, `%${page.q}%`));
  if (page.from) extra.push(gte(events.startsAt, new Date(page.from)));
  if (page.to) extra.push(lte(events.startsAt, new Date(page.to)));
  // A status filter can only narrow what the caller may already see.
  if (page.status) extra.push(eq(events.status, page.status as typeof events.$inferSelect.status));
  const finalWhere = extra.length ? and(where, ...extra) : where;
  const rows = await db
    .select()
    .from(events)
    .where(finalWhere)
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(page.limit + 1)
    .offset(page.offset);
  return {
    items: rows.slice(0, page.limit),
    hasMore: rows.length > page.limit,
    limit: page.limit,
    offset: page.offset,
  };
}

export async function getVisibleEvent(auth: AuthContext, id: string) {
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  const [invite] = await db
    .select()
    .from(eventInvitations)
    .where(and(eq(eventInvitations.eventId, id), eq(eventInvitations.email, auth.user.email)))
    .limit(1);
  const invitedIds = new Set(
    invite && !invite.revokedAt && (!invite.expiresAt || invite.expiresAt.getTime() > Date.now())
      ? [id]
      : [],
  );
  const staffOversight =
    hasRole(auth, "ADMIN") || hasRole(auth, "HOD_DEAN") || hasRole(auth, "FACULTY");
  const isClubMember = auth.memberships.some((m) => m.clubId === event.clubId);
  if (!canSeeEvent(auth, event, invitedIds, staffOversight || isClubMember))
    throw new ApiError("NOT_FOUND", "Event not found.");
  return event;
}

function canSeeEvent(
  auth: AuthContext,
  event: typeof events.$inferSelect,
  invitedIds: Set<string>,
  oversight: boolean,
): boolean {
  if (!PUBLIC_STATUSES.includes(event.status as (typeof PUBLIC_STATUSES)[number]) && !oversight)
    return false;
  if (oversight) return true;
  if (event.audience === "COLLEGE_ONLY") return auth.user.accountType !== "OUTSIDER_STUDENT";
  if (event.audience === "OUTSIDERS_ALLOWED") return true;
  if (event.audience === "INVITED_ONLY") return invitedIds.has(event.id);
  return false;
}
