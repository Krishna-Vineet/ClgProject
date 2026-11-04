import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { getDb } from "../../db/client";
import {
  events,
  announcementReads,
  announcements,
  notificationDevices,
  registrations,
  users,
} from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { assertEventManage, assertEventOrganiserRead } from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { getVisibleEvent, visibleEventPredicate } from "../events/visibility";
import { queueNotification } from "../notifications/outbox";
import type { CreateAnnouncementInput } from "./schemas";

/**
 * Announcements are event-scoped and deliberately narrow: only the event's own
 * coordinators may post, and a participant only sees announcements for events
 * they can actually see. REGISTERED additionally requires a live registration.
 */
export async function create(
  auth: AuthContext,
  eventId: string,
  input: CreateAnnouncementInput,
  audit?: AuditContext,
) {
  const event = await assertEventManage(auth, eventId);
  if (!["PUBLISHED", "LIVE", "READY", "COMPLETED"].includes(event.status))
    throw new ApiError(
      "INVALID_STATE_TRANSITION",
      "Publish the event before announcing to its participants.",
    );
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(announcements)
      .values({
        eventId,
        title: input.title,
        body: input.body,
        audience: input.audience,
        isPinned: input.isPinned,
        createdBy: auth.user.id,
      })
      .returning();
    if (!row) throw new ApiError("INTERNAL_ERROR", "Could not post the announcement.");

    // The audience size is reported whether or not push is enabled, so the
    // coordinator always sees how many people the announcement reaches.
    const targets = await tx
      .select({ userId: registrations.userId })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, eventId),
          inArray(registrations.status, ["CONFIRMED", "WAITLISTED", "APPLIED"]),
        ),
      )
      .limit(env.OUTBOX_FANOUT_MAX);
    const recipients = targets.length;
    if (input.push) {
      // Capped by config so one announcement cannot enqueue an unbounded number
      // of deliveries.
      for (const target of targets) {
        await queueNotification(tx, {
          kind: "EVENT_ANNOUNCEMENT",
          recipientUserId: target.userId,
          eventId,
          subject: `${event.title}: ${input.title}`,
          body: input.body,
          payload: { announcementId: row.id, eventId, push: true },
        });
      }
    }
    if (audit)
      await insertAudit(tx, audit, {
        action: "ANNOUNCEMENT_POSTED",
        entityType: "announcement",
        entityId: row.id,
        eventId,
        clubId: event.clubId,
        after: { audience: input.audience, isPinned: input.isPinned, recipients },
      });
    return { announcement: row, recipients };
  });
}

/** Organiser view: everything posted for the event, including revoked items. */
export async function listForOrganiser(
  auth: AuthContext,
  eventId: string,
  limit: number,
  offset: number,
) {
  await assertEventOrganiserRead(auth, eventId);
  const { db } = getDb();
  const rows = await db
    .select({
      announcement: announcements,
      authorName: users.fullName,
      readCount: sql<number>`(select count(*)::int from announcement_reads ar where ar.announcement_id = ${announcements.id})`,
    })
    .from(announcements)
    .innerJoin(users, eq(users.id, announcements.createdBy))
    .where(eq(announcements.eventId, eventId))
    .orderBy(desc(announcements.isPinned), desc(announcements.publishedAt))
    .limit(limit + 1)
    .offset(offset);
  return {
    items: rows.slice(0, limit).map((r) => ({
      ...r.announcement,
      authorName: r.authorName,
      readCount: r.readCount,
    })),
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}

export async function revoke(auth: AuthContext, announcementId: string, audit?: AuditContext) {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(announcements)
    .where(eq(announcements.id, announcementId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Announcement not found.");
  const event = await assertEventManage(auth, row.eventId);
  if (row.revokedAt) return row;
  const [updated] = await db
    .update(announcements)
    .set({ revokedAt: new Date() })
    .where(eq(announcements.id, announcementId))
    .returning();
  if (audit)
    await insertAudit(db, audit, {
      action: "ANNOUNCEMENT_REVOKED",
      entityType: "announcement",
      entityId: announcementId,
      eventId: row.eventId,
      clubId: event.clubId,
      after: { revoked: true },
    });
  return updated;
}

/**
 * The phone's announcement inbox across every event it can see. Visibility is
 * re-resolved per event through the same rules as the event feed, so an
 * announcement can never leak an event the participant cannot open.
 */
export async function myInbox(auth: AuthContext, limit: number, offset: number) {
  const { db } = getDb();
  // Visibility is applied as a database predicate, not by paging a capped list
  // of events, so a recent announcement is never missed on a busy database.
  const visible = await visibleEventPredicate(auth);

  const myRegs = await db
    .select({ eventId: registrations.eventId })
    .from(registrations)
    .where(
      and(
        eq(registrations.userId, auth.user.id),
        inArray(registrations.status, ["CONFIRMED", "WAITLISTED", "APPLIED"]),
      ),
    );
  const registeredIds = myRegs.map((r) => r.eventId);

  const scope = and(
    visible,
    isNull(announcements.revokedAt),
    or(
      eq(announcements.audience, "ALL_VISIBLE"),
      registeredIds.length ? inArray(announcements.eventId, registeredIds) : sql`false`,
    ),
  );

  const rows = await db
    .select({
      announcement: announcements,
      eventTitle: events.title,
      authorName: users.fullName,
      readAt: announcementReads.readAt,
    })
    .from(announcements)
    .innerJoin(events, eq(events.id, announcements.eventId))
    .innerJoin(users, eq(users.id, announcements.createdBy))
    .leftJoin(
      announcementReads,
      and(
        eq(announcementReads.announcementId, announcements.id),
        eq(announcementReads.userId, auth.user.id),
      ),
    )
    .where(scope)
    .orderBy(desc(announcements.isPinned), desc(announcements.publishedAt))
    .limit(limit + 1)
    .offset(offset);

  // Unread is counted across the whole inbox, not just the returned page.
  const [unreadRow] = await db
    .select({ n: count() })
    .from(announcements)
    .innerJoin(events, eq(events.id, announcements.eventId))
    .leftJoin(
      announcementReads,
      and(
        eq(announcementReads.announcementId, announcements.id),
        eq(announcementReads.userId, auth.user.id),
      ),
    )
    .where(and(scope, isNull(announcementReads.readAt)));

  return {
    items: rows.slice(0, limit).map((r) => ({
      ...r.announcement,
      // `event` is the shape the phone renders; eventTitle is kept for the portal.
      event: { id: r.announcement.eventId, title: r.eventTitle },
      eventTitle: r.eventTitle,
      authorName: r.authorName,
      readAt: r.readAt,
    })),
    unread: unreadRow?.n ?? 0,
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}

export async function markRead(auth: AuthContext, announcementId: string) {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(announcements)
    .where(eq(announcements.id, announcementId))
    .limit(1);
  if (!row || row.revokedAt) throw new ApiError("NOT_FOUND", "Announcement not found.");
  // Re-check visibility rather than trusting that the id came from the inbox.
  await getVisibleEvent(auth, row.eventId);
  if (row.audience === "REGISTERED") {
    const [reg] = await db
      .select({ id: registrations.id })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, row.eventId),
          eq(registrations.userId, auth.user.id),
          inArray(registrations.status, ["CONFIRMED", "WAITLISTED", "APPLIED"]),
        ),
      )
      .limit(1);
    if (!reg) throw new ApiError("NOT_FOUND", "Announcement not found.");
  }
  await db
    .insert(announcementReads)
    .values({ announcementId, userId: auth.user.id })
    .onConflictDoNothing();
  return { read: true };
}

// ── Push devices ────────────────────────────────────────────────────────────

/**
 * Register (or re-activate) this device for the signed-in account. A token that
 * previously belonged to another account is reassigned: phones are shared, and
 * the previous owner must stop receiving the new owner's notifications.
 */
export async function registerDevice(
  auth: AuthContext,
  input: { expoPushToken: string; platform: "ios" | "android" | "web" },
) {
  const { db } = getDb();
  const [row] = await db
    .insert(notificationDevices)
    .values({
      userId: auth.user.id,
      expoPushToken: input.expoPushToken,
      platform: input.platform,
      isActive: true,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: notificationDevices.expoPushToken,
      set: {
        userId: auth.user.id,
        platform: input.platform,
        isActive: true,
        lastSeenAt: new Date(),
      },
    })
    .returning();
  return { device: row };
}

export async function removeDevice(auth: AuthContext, expoPushToken: string) {
  const { db } = getDb();
  const rows = await db
    .update(notificationDevices)
    .set({ isActive: false })
    .where(
      and(
        eq(notificationDevices.expoPushToken, expoPushToken),
        eq(notificationDevices.userId, auth.user.id),
      ),
    )
    .returning({ id: notificationDevices.id });
  return { removed: rows.length };
}

export async function myDevices(auth: AuthContext) {
  const { db } = getDb();
  const items = await db
    .select({
      id: notificationDevices.id,
      platform: notificationDevices.platform,
      isActive: notificationDevices.isActive,
      lastSeenAt: notificationDevices.lastSeenAt,
      createdAt: notificationDevices.createdAt,
    })
    .from(notificationDevices)
    .where(eq(notificationDevices.userId, auth.user.id))
    .orderBy(desc(notificationDevices.lastSeenAt));
  return { items };
}
