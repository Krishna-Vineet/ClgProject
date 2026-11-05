import { and, asc, count, eq, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { getDb } from "../../db/client";
import { events, clubs, passes, registrationHistory, registrations, users } from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { assertEventManage, assertEventOrganiserRead } from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { getVisibleEvent } from "../events/visibility";
import { queueNotification } from "../notifications/outbox";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["db"]["transaction"]>[0]>[0];

/**
 * Promote the longest-waiting participant into a freed seat. Called inside the
 * same transaction and under the same event row lock as the withdrawal, so the
 * confirmed count can never exceed capacity and two withdrawals cannot promote
 * the same person twice.
 *
 * Returns the promoted registration id, or null when nobody is waiting.
 */
async function promoteNext(tx: Tx, eventId: string, actorId: string): Promise<string | null> {
  const [event] = await tx.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) return null;
  // Manual and quiz admission are decided by people, not by queue order.
  if (event.admissionMode !== "FCFS") return null;
  if (!["PUBLISHED", "LIVE"].includes(event.status)) return null;

  const [taken] = await tx
    .select({ n: count() })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "CONFIRMED")));
  if ((taken?.n ?? 0) >= event.capacity) return null;

  const [next] = await tx
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "WAITLISTED")))
    .orderBy(asc(registrations.queuePosition), asc(registrations.appliedAt), asc(registrations.id))
    .for("update", { skipLocked: true })
    .limit(1);
  if (!next) return null;

  const now = new Date();
  await tx
    .update(registrations)
    .set({
      status: "CONFIRMED",
      confirmedAt: now,
      queuePosition: null,
      promotedFromWaitlist: true,
      updatedAt: now,
    })
    .where(eq(registrations.id, next.id));
  await tx.insert(registrationHistory).values({
    registrationId: next.id,
    fromStatus: "WAITLISTED",
    toStatus: "CONFIRMED",
    actorId,
    reason: "A seat became free; promoted from the waitlist in queue order.",
  });
  await tx
    .insert(passes)
    .values({ registrationId: next.id })
    .onConflictDoNothing({ target: passes.registrationId });
  await tx.update(passes).set({ revokedAt: null }).where(eq(passes.registrationId, next.id));

  // Close the gap so queue positions stay a dense 1..n sequence.
  await tx.execute(sql`
    WITH ordered AS (
      SELECT id, row_number() OVER (ORDER BY queue_position, applied_at, id) AS rn
      FROM registrations
      WHERE event_id = ${eventId} AND status = 'WAITLISTED'
    )
    UPDATE registrations r SET queue_position = ordered.rn
    FROM ordered WHERE r.id = ordered.id AND r.queue_position IS DISTINCT FROM ordered.rn
  `);

  await queueNotification(tx, {
    kind: "REGISTRATION_PROMOTED",
    recipientUserId: next.userId,
    eventId,
    subject: `A seat opened up: ${event.title}`,
    body: `You have been confirmed for ${event.title} from the waitlist. Your entry pass is ready in the app.`,
    payload: { registrationId: next.id, eventId },
  });
  return next.id;
}

/**
 * Participant withdrawal. Allowed until the event starts; after that the seat
 * was held and the coordinator must decide. Cancelling revokes the pass in the
 * same transaction so a withdrawn participant cannot still scan in.
 *
 * A withdrawal is *not* a life sentence. The row is kept as CANCELLED so the
 * roster, the pass audit and the waitlist arithmetic stay intact, but the phone
 * stops showing it and `register()` reclaims the same row if the student comes
 * back — see `reclaim()` in service.ts. Refusing a returning student forever is
 * how a "leave" button turns into a "you cannot change your mind" button.
 */
export async function withdraw(
  auth: AuthContext,
  eventId: string,
  reason: string | undefined,
  audit?: AuditContext,
) {
  await getVisibleEvent(auth, eventId);
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .for("update")
      .limit(1);
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    const [registration] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, auth.user.id)))
      .for("update")
      .limit(1);
    if (!registration) throw new ApiError("NOT_FOUND", "You are not registered for this event.");
    if (registration.status === "CANCELLED")
      return { registration, promotedRegistrationId: null, alreadyCancelled: true };
    if (registration.status === "REJECTED")
      throw new ApiError("INVALID_STATE_TRANSITION", "This application was already rejected.");
    const now = new Date();
    // A live or finished event has already consumed the seat.
    if (event.startsAt <= now && ["LIVE", "COMPLETED"].includes(event.status))
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        "This event has already started. Ask the coordinator to release your seat.",
      );

    const freedSeat = registration.status === "CONFIRMED";
    const [updated] = await tx
      .update(registrations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        queuePosition: null,
        withdrawnBy: auth.user.id,
        withdrawalReason: reason ?? null,
        updatedAt: now,
      })
      .where(eq(registrations.id, registration.id))
      .returning();
    await tx.insert(registrationHistory).values({
      registrationId: registration.id,
      fromStatus: registration.status,
      toStatus: "CANCELLED",
      actorId: auth.user.id,
      reason: reason ?? "Withdrawn by the participant.",
    });
    await tx
      .update(passes)
      .set({ revokedAt: now })
      .where(eq(passes.registrationId, registration.id));

    const promoted = freedSeat ? await promoteNext(tx, eventId, auth.user.id) : null;
    if (audit)
      await insertAudit(tx, audit, {
        action: "PARTICIPANT_WITHDREW",
        entityType: "registration",
        entityId: registration.id,
        eventId,
        clubId: event.clubId,
        after: { freedSeat, promotedRegistrationId: promoted, reason: reason ?? null },
      });
    return { registration: updated, promotedRegistrationId: promoted, alreadyCancelled: false };
  });
}

/** Organiser removes a participant (no-show policy, misconduct, duplicate). */
export async function removeParticipant(
  auth: AuthContext,
  eventId: string,
  registrationId: string,
  reason: string,
  audit?: AuditContext,
) {
  const event = await assertEventManage(auth, eventId);
  const { db } = getDb();
  return db.transaction(async (tx) => {
    await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId)).for("update");
    const [registration] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.id, registrationId), eq(registrations.eventId, eventId)))
      .for("update")
      .limit(1);
    if (!registration) throw new ApiError("NOT_FOUND", "Registration not found for this event.");
    if (registration.status === "CANCELLED")
      return { registration, promotedRegistrationId: null, alreadyCancelled: true };
    const now = new Date();
    const freedSeat = registration.status === "CONFIRMED";
    const [updated] = await tx
      .update(registrations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        queuePosition: null,
        withdrawnBy: auth.user.id,
        withdrawalReason: reason,
        updatedAt: now,
      })
      .where(eq(registrations.id, registrationId))
      .returning();
    await tx.insert(registrationHistory).values({
      registrationId,
      fromStatus: registration.status,
      toStatus: "CANCELLED",
      actorId: auth.user.id,
      reason,
    });
    await tx
      .update(passes)
      .set({ revokedAt: now })
      .where(eq(passes.registrationId, registrationId));
    const promoted = freedSeat ? await promoteNext(tx, eventId, auth.user.id) : null;
    await queueNotification(tx, {
      kind: "REGISTRATION_RELEASED",
      recipientUserId: registration.userId,
      eventId,
      subject: `Your place was released: ${event.title}`,
      body: `An organiser released your place for ${event.title}. Reason: ${reason}`,
      payload: { registrationId, eventId },
    });
    if (audit)
      await insertAudit(tx, audit, {
        action: "PARTICIPANT_REMOVED",
        entityType: "registration",
        entityId: registrationId,
        eventId,
        clubId: event.clubId,
        after: { reason, promotedRegistrationId: promoted },
      });
    return { registration: updated, promotedRegistrationId: promoted, alreadyCancelled: false };
  });
}

/**
 * Decide a MANUAL application. Confirmation respects capacity: if the event is
 * full the applicant is waitlisted instead, and the response says so rather than
 * silently overbooking.
 */
export async function decideApplication(
  auth: AuthContext,
  eventId: string,
  registrationId: string,
  decision: "CONFIRMED" | "REJECTED",
  note: string | undefined,
  audit?: AuditContext,
) {
  const event = await assertEventManage(auth, eventId);
  if (event.admissionMode !== "MANUAL")
    throw new ApiError(
      "VALIDATION_ERROR",
      "Only manual-admission events have applications to decide.",
    );
  const { db } = getDb();
  return db.transaction(async (tx) => {
    await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId)).for("update");
    const [registration] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.id, registrationId), eq(registrations.eventId, eventId)))
      .for("update")
      .limit(1);
    if (!registration) throw new ApiError("NOT_FOUND", "Registration not found for this event.");
    if (registration.status !== "APPLIED" && registration.status !== "WAITLISTED")
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        `This registration is ${registration.status} and has no pending decision.`,
      );

    const now = new Date();
    let status: "CONFIRMED" | "WAITLISTED" | "REJECTED" = decision;
    let queuePosition: number | null = null;
    if (decision === "CONFIRMED") {
      const [taken] = await tx
        .select({ n: count() })
        .from(registrations)
        .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "CONFIRMED")));
      if ((taken?.n ?? 0) >= event.capacity) {
        status = "WAITLISTED";
        const [tail] = await tx
          .select({ n: sql<number>`coalesce(max(${registrations.queuePosition}), 0)::int` })
          .from(registrations)
          .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "WAITLISTED")));
        queuePosition = (tail?.n ?? 0) + 1;
      }
    }

    const [updated] = await tx
      .update(registrations)
      .set({
        status,
        queuePosition,
        confirmedAt: status === "CONFIRMED" ? now : null,
        rejectionReason: status === "REJECTED" ? (note ?? "Not selected by the organisers.") : null,
        decidedBy: auth.user.id,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(registrations.id, registrationId))
      .returning();
    await tx.insert(registrationHistory).values({
      registrationId,
      fromStatus: registration.status,
      toStatus: status,
      actorId: auth.user.id,
      reason:
        note ??
        (status === "WAITLISTED"
          ? "Approved, but the event is full; added to the waitlist."
          : status === "CONFIRMED"
            ? "Application approved."
            : "Application rejected."),
    });
    if (status === "CONFIRMED") {
      await tx
        .insert(passes)
        .values({ registrationId })
        .onConflictDoNothing({ target: passes.registrationId });
      await tx
        .update(passes)
        .set({ revokedAt: null })
        .where(eq(passes.registrationId, registrationId));
    } else {
      await tx
        .update(passes)
        .set({ revokedAt: now })
        .where(eq(passes.registrationId, registrationId));
    }
    await queueNotification(tx, {
      kind: "APPLICATION_DECIDED",
      recipientUserId: registration.userId,
      eventId,
      subject: `Application update: ${event.title}`,
      body:
        status === "CONFIRMED"
          ? `You are confirmed for ${event.title}. Your entry pass is in the app.`
          : status === "WAITLISTED"
            ? `You are approved for ${event.title} but it is full. You are number ${queuePosition} on the waitlist.`
            : `Your application for ${event.title} was not selected.${note ? ` ${note}` : ""}`,
      payload: { registrationId, status, eventId },
    });
    if (audit)
      await insertAudit(tx, audit, {
        action: "APPLICATION_DECIDED",
        entityType: "registration",
        entityId: registrationId,
        eventId,
        clubId: event.clubId,
        after: { requested: decision, applied: status, note: note ?? null },
      });
    return { registration: updated, requested: decision, applied: status };
  });
}

/** Organiser participant roster with the filters the portal needs. */
export async function roster(
  auth: AuthContext,
  eventId: string,
  query: { status?: string | undefined; q?: string | undefined; limit: number; offset: number },
) {
  await assertEventOrganiserRead(auth, eventId);
  const { db } = getDb();
  const conditions = [eq(registrations.eventId, eventId)];
  if (query.status)
    conditions.push(
      eq(registrations.status, query.status as (typeof registrations.$inferSelect)["status"]),
    );
  if (query.q) {
    const needle = `%${query.q.toLowerCase()}%`;
    conditions.push(
      sql`lower(${users.fullName}) like ${needle} or lower(${users.email}) like ${needle}`,
    );
  }
  const where = and(...conditions);
  const rows = await db
    .select({
      registration: registrations,
      fullName: users.fullName,
      email: users.email,
      accountType: users.accountType,
      passId: passes.id,
      passRevokedAt: passes.revokedAt,
      checkedIn: sql<string | null>`(
        select min(sl.created_at) from scan_logs sl
        where sl.event_id = ${eventId} and sl.result = 'GRANTED'
          and sl.pass_id = ${passes.id}
      )`,
    })
    .from(registrations)
    .innerJoin(users, eq(users.id, registrations.userId))
    .leftJoin(passes, eq(passes.registrationId, registrations.id))
    .where(where)
    .orderBy(asc(registrations.appliedAt), asc(registrations.id))
    .limit(query.limit + 1)
    .offset(query.offset);
  const [totals] = await db
    .select({
      total: count(),
      confirmed: sql<number>`count(*) filter (where ${registrations.status} = 'CONFIRMED')::int`,
      waitlisted: sql<number>`count(*) filter (where ${registrations.status} = 'WAITLISTED')::int`,
      applied: sql<number>`count(*) filter (where ${registrations.status} = 'APPLIED')::int`,
      cancelled: sql<number>`count(*) filter (where ${registrations.status} = 'CANCELLED')::int`,
      rejected: sql<number>`count(*) filter (where ${registrations.status} = 'REJECTED')::int`,
    })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return {
    items: rows.slice(0, query.limit).map((r) => ({
      ...r.registration,
      fullName: r.fullName,
      email: r.email,
      accountType: r.accountType,
      passId: r.passId,
      passRevokedAt: r.passRevokedAt,
      checkedInAt: r.checkedIn,
    })),
    totals: totals ?? {
      total: 0,
      confirmed: 0,
      waitlisted: 0,
      applied: 0,
      cancelled: 0,
      rejected: 0,
    },
    capacity: event?.capacity ?? 0,
    admissionMode: event?.admissionMode ?? "FCFS",
    limit: query.limit,
    offset: query.offset,
    hasMore: rows.length > query.limit,
  };
}

/** Participant's own history for one registration, so a decision is explainable. */
export async function myHistory(auth: AuthContext, eventId: string) {
  await getVisibleEvent(auth, eventId);
  const { db } = getDb();
  const [registration] = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, auth.user.id)))
    .limit(1);
  if (!registration) return { registration: null, items: [] };
  const items = await db
    .select({
      id: registrationHistory.id,
      fromStatus: registrationHistory.fromStatus,
      toStatus: registrationHistory.toStatus,
      reason: registrationHistory.reason,
      createdAt: registrationHistory.createdAt,
    })
    .from(registrationHistory)
    .where(eq(registrationHistory.registrationId, registration.id))
    .orderBy(asc(registrationHistory.createdAt));
  return { registration, items };
}

export { promoteNext };

/**
 * Full participant export as CSV, scoped exactly like the roster reader.
 * Exports are deliberately not paginated: a coordinator needs the whole list for
 * attendance sheets and reconciliation, and a few thousand rows is small.
 */
export async function rosterCsv(auth: AuthContext, eventId: string) {
  await assertEventOrganiserRead(auth, eventId);
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  const rows = await db
    .select({
      fullName: users.fullName,
      email: users.email,
      phone: users.phone,
      accountType: users.accountType,
      status: registrations.status,
      appliedAt: registrations.appliedAt,
      decidedAt: registrations.decidedAt,
      queuePosition: registrations.queuePosition,
      passId: passes.id,
      checkedInAt: sql<string | null>`(
        select min(sl.created_at) from scan_logs sl
        where sl.event_id = ${eventId} and sl.result = 'GRANTED'
          and sl.pass_id = ${passes.id}
      )`,
    })
    .from(registrations)
    .innerJoin(users, eq(users.id, registrations.userId))
    .leftJoin(passes, eq(passes.registrationId, registrations.id))
    .where(eq(registrations.eventId, eventId))
    .orderBy(asc(registrations.appliedAt), asc(registrations.id));

  const csvCell = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = [
    "Name",
    "Email",
    "Phone",
    "Account type",
    "Status",
    "Applied at",
    "Decided at",
    "Waitlist position",
    "Pass id",
    "Checked in at",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.fullName,
        r.email,
        r.phone ?? "",
        r.accountType,
        r.status,
        r.appliedAt.toISOString(),
        r.decidedAt?.toISOString() ?? "",
        r.queuePosition ?? "",
        r.passId ?? "",
        r.checkedInAt ? new Date(r.checkedInAt).toISOString() : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const safeSlug = event.slug.replace(/[^a-z0-9-]/gi, "") || "event";
  const bom = String.fromCharCode(0xfeff);
  const newline = String.fromCharCode(13, 10);
  return {
    filename: `${safeSlug}-participants.csv`,
    csv: `${bom}${lines.join(newline)}`,
    count: rows.length,
  };
}
