import {
  ELIGIBILITY_REASON_LABELS,
  type EligibilityReason,
  eligibilityPolicySchema,
  evaluateEligibility,
} from "@campusops/shared";
import { and, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  events,
  clubs,
  eventInvitations,
  passes,
  registrationHistory,
  registrations,
  studentProfiles,
} from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { eligibilityPreview } from "../events/service";
import { getVisibleEvent } from "../events/visibility";

/**
 * Participant registration. Seats are allocated under a row lock on the event,
 * so two phones cannot take the last seat. Eligibility and audience are checked
 * again inside that lock, not trusted from the preview the phone displayed.
 */
export async function register(auth: AuthContext, eventId: string, audit?: AuditContext) {
  // Visibility first: an invisible event must not reveal that it exists.
  await getVisibleEvent(auth, eventId);
  if (auth.user.accountType === "STAFF")
    throw new ApiError(
      "FORBIDDEN",
      "Staff accounts organise events; they do not register as participants.",
    );
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
      if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
      const [club] = await tx.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);
      if (!club?.isActive) throw new ApiError("EVENT_NOT_OPEN", "This club is not active.");
      if (event.status !== "PUBLISHED" && event.status !== "LIVE")
        throw new ApiError("EVENT_NOT_OPEN", "This event is not open for registration.");
      const now = new Date();
      if (now < event.registrationOpensAt || now > event.registrationClosesAt)
        throw new ApiError("EVENT_NOT_OPEN", "Registration is not open at this time.");

      const [existing] = await tx
        .select()
        .from(registrations)
        .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, auth.user.id)))
        .limit(1);
      if (existing) {
        if (existing.status === "CANCELLED" || existing.status === "REJECTED")
          throw new ApiError("CONFLICT", "This registration is closed. Contact the coordinator.");
        const [pass] = await tx
          .select({ id: passes.id })
          .from(passes)
          .where(eq(passes.registrationId, existing.id))
          .limit(1);
        return { registration: existing, passId: pass?.id ?? null, alreadyRegistered: true };
      }

      const [invite] = await tx
        .select({ id: eventInvitations.id })
        .from(eventInvitations)
        .where(
          and(
            eq(eventInvitations.eventId, eventId),
            eq(eventInvitations.email, auth.user.email),
            isNull(eventInvitations.revokedAt),
            or(isNull(eventInvitations.expiresAt), gt(eventInvitations.expiresAt, now)),
          ),
        )
        .limit(1);
      const hasInvitation = Boolean(invite);
      if (event.audience === "INVITED_ONLY" && !hasInvitation)
        throw new ApiError("NOT_ELIGIBLE", "You need an invitation to register for this event.");
      if (event.audience === "COLLEGE_ONLY" && auth.user.accountType === "OUTSIDER_STUDENT")
        throw new ApiError("NOT_ELIGIBLE", "This event is open to college students only.");

      const [student] = await tx
        .select()
        .from(studentProfiles)
        .where(eq(studentProfiles.userId, auth.user.id))
        .limit(1);
      const policy = eligibilityPolicySchema.parse(event.eligibilityPolicy);
      const eligibility = evaluateEligibility(policy, {
        accountType: auth.user.accountType,
        departmentId: student?.departmentId ?? null,
        graduationYear: student?.graduationYear ?? null,
        hasInvitation,
      });
      if (!eligibility.eligible)
        throw new ApiError("NOT_ELIGIBLE", "You do not meet this event's eligibility rules.", {
          reasons: eligibility.reasons,
          messages: eligibility.reasons.map((r: EligibilityReason) => ELIGIBILITY_REASON_LABELS[r]),
        });

      // Quiz admission: registering expresses interest, it does not grant a
      // seat. The seat comes from the quiz result (see modules/quizzes), so the
      // registration stays APPLIED until the attempt is graded or allocated.
      const quizAdmission =
        event.admissionMode === "QUIZ_TOP_N" || event.admissionMode === "QUIZ_FIRST_QUALIFIED";

      let status: "CONFIRMED" | "WAITLISTED" | "APPLIED" = "APPLIED";
      let queuePosition: number | null = null;
      if (event.admissionMode === "FCFS") {
        const [taken] = await tx
          .select({ n: count() })
          .from(registrations)
          .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "CONFIRMED")));
        if ((taken?.n ?? 0) < event.capacity) {
          status = "CONFIRMED";
        } else {
          status = "WAITLISTED";
          const [tail] = await tx
            .select({ n: sql<number>`coalesce(max(${registrations.queuePosition}), 0)::int` })
            .from(registrations)
            .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "WAITLISTED")));
          queuePosition = (tail?.n ?? 0) + 1;
        }
      }

      const [registration] = await tx
        .insert(registrations)
        .values({
          eventId,
          userId: auth.user.id,
          status,
          admissionModeSnapshot: event.admissionMode,
          eligibilitySnapshot: { policy, result: eligibility, hasInvitation },
          eventRevision: event.currentRevision,
          queuePosition,
          ...(status === "CONFIRMED" ? { confirmedAt: now } : {}),
        })
        .returning();
      if (!registration) throw new ApiError("INTERNAL_ERROR", "Registration failed.");
      await tx.insert(registrationHistory).values({
        registrationId: registration.id,
        fromStatus: null,
        toStatus: status,
        actorId: auth.user.id,
        reason: quizAdmission
          ? "Registered; seat depends on the quiz result."
          : "Registered from the mobile app.",
      });
      let passId: string | null = null;
      if (status === "CONFIRMED") {
        const [pass] = await tx
          .insert(passes)
          .values({ registrationId: registration.id })
          .returning({ id: passes.id });
        passId = pass?.id ?? null;
      }
      if (audit)
        await insertAudit(tx, audit, {
          action: "PARTICIPANT_REGISTERED",
          entityType: "registration",
          entityId: registration.id,
          eventId,
          clubId: event.clubId,
          after: { status, admissionMode: event.admissionMode, queuePosition },
        });
      return { registration, passId, alreadyRegistered: false };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "You are already registered for this event.");
    throw err;
  }
}

/** The phone's own registrations, newest first, with event and pass context. */
export async function mine(auth: AuthContext, limit = 25, offset = 0) {
  const { db } = getDb();
  const rows = await db
    .select({
      registration: registrations,
      event: events,
      clubName: clubs.name,
      passId: passes.id,
      passRevokedAt: passes.revokedAt,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .leftJoin(passes, eq(passes.registrationId, registrations.id))
    .where(eq(registrations.userId, auth.user.id))
    .orderBy(desc(registrations.appliedAt), desc(registrations.id))
    .limit(limit + 1)
    .offset(offset);
  return {
    items: rows.slice(0, limit).map((r) => ({
      ...r.registration,
      event: r.event,
      clubName: r.clubName,
      passId: r.passId,
      passRevokedAt: r.passRevokedAt,
    })),
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}

/** One round trip for the mobile event-detail screen. */
export async function participantView(auth: AuthContext, eventId: string) {
  const event = await getVisibleEvent(auth, eventId);
  const { db } = getDb();
  const [club] = await db
    .select({ name: clubs.name })
    .from(clubs)
    .where(eq(clubs.id, event.clubId))
    .limit(1);
  const [registration] = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, auth.user.id)))
    .limit(1);
  const [taken] = await db
    .select({ n: count() })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "CONFIRMED")));
  const eligibility = await eligibilityPreview(auth, eventId);
  return {
    event,
    club: { id: event.clubId, name: club?.name ?? "Campus club" },
    registration: registration ?? null,
    eligibility,
    confirmedCount: taken?.n ?? 0,
    seatsRemaining:
      event.admissionMode === "FCFS" ? Math.max(0, event.capacity - (taken?.n ?? 0)) : null,
  };
}
