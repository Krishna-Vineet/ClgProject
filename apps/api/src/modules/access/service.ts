import {
  type AccessQr,
  type IdentityCheck,
  decideAccess,
  effectiveEventStatus,
  qrTypeLimit,
  standingFor,
} from "@campusops/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { env } from "../../config/env";
import { getDb } from "../../db/client";
import {
  events,
  checkpoints,
  passes,
  qrNonces,
  redemptions,
  registrations,
  scanLogs,
  studentProfiles,
  users,
} from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { isClubCoordinator, isClubOrganiser } from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { newNonce, signQrPayload, verifyQrToken } from "../../utils/qr-token";
import { type AuditContext, insertAudit } from "../audit/service";
import type {
  accessLogQuerySchema,
  createCheckpointSchema,
  inspectScanSchema,
  scanSchema,
  updateCheckpointSchema,
} from "./schemas";

/**
 * Scanning is done by the people running the event: its club's coordinators and
 * its club faculty. There is no separate scanning-staff account. Oversight is
 * read-only, so Admin and HOD/Dean do not scan either.
 */
// Two joins to `users` in one query: the scanner and the participant.
const participantUser = alias(users, "participant_user");

export function assertMayScan(auth: AuthContext, clubId: string) {
  if (isClubOrganiser(auth, clubId)) return;
  throw new ApiError(
    "FORBIDDEN",
    "Only this event's coordinators and club faculty can scan access QRs.",
  );
}

/**
 * Adapt a database row to the pure decision shape. Kept in one place so the API
 * and the mobile app cannot disagree about what a QR means.
 */
function toAccessQr(row: typeof checkpoints.$inferSelect): AccessQr {
  return {
    id: row.id,
    name: row.name,
    qrType: row.qrType,
    maxUses: row.maxUses,
    validityMode: row.validityMode,
    validFrom: row.startsAt,
    validUntil: row.endsAt,
    validOn: row.validOn,
    isActive: row.isActive,
    requiresIdCheck: row.requiresIdCheck,
  };
}

async function loadEvent(eventId: string) {
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  return event;
}

/** A counter is managed only by the coordinators of its event's club. */
export async function assertCheckpointManageable(auth: AuthContext, checkpointId: string) {
  const cp = await loadCheckpoint(checkpointId);
  const event = await loadEvent(cp.eventId);
  if (isClubCoordinator(auth, event.clubId)) return cp;
  throw new ApiError("FORBIDDEN", "Only this event's coordinators can manage its counters.");
}

/** A pass is revoked only by the coordinators of its event's club. */
export async function assertPassManageable(auth: AuthContext, passId: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ eventId: registrations.eventId })
    .from(passes)
    .innerJoin(registrations, eq(registrations.id, passes.registrationId))
    .where(eq(passes.id, passId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Pass not found.");
  const event = await loadEvent(row.eventId);
  if (isClubCoordinator(auth, event.clubId)) return;
  throw new ApiError("FORBIDDEN", "Only this event's coordinators can manage its passes.");
}

async function loadCheckpoint(checkpointId: string) {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.id, checkpointId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Checkpoint not found.");
  return row;
}

/**
 * Usage counts per checkpoint, so the portal shows turns used at a glance.
 *
 * The outer column is written out as "checkpoints"."id" on purpose. Drizzle
 * renders an interpolated column inside a select field unqualified ("id"), which
 * a correlated subquery would then resolve against its OWN table — silently
 * counting zero instead of failing.
 */
export async function listCheckpoints(eventId: string) {
  const { db } = getDb();
  const rows = await db
    .select({
      checkpoint: checkpoints,
      uses: sql<number>`(SELECT count(*)::int FROM redemptions r WHERE r.checkpoint_id = "checkpoints"."id")`,
      people: sql<number>`(SELECT count(DISTINCT r.pass_id)::int FROM redemptions r WHERE r.checkpoint_id = "checkpoints"."id")`,
      denied: sql<number>`(SELECT count(*)::int FROM scan_logs sl WHERE sl.checkpoint_id = "checkpoints"."id" AND sl.result = 'DENIED')`,
    })
    .from(checkpoints)
    .where(eq(checkpoints.eventId, eventId))
    .orderBy(asc(checkpoints.createdAt), asc(checkpoints.name));
  return rows.map((r) => ({ ...r.checkpoint, uses: r.uses, people: r.people, denied: r.denied }));
}

export async function createCheckpoint(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof createCheckpointSchema>,
  audit?: AuditContext,
) {
  const event = await loadEvent(eventId);
  if (event.status === "COMPLETED" || event.status === "CANCELLED")
    throw new ApiError("INVALID_STATE_TRANSITION", "This event is closed.");
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(checkpoints)
        .values({
          eventId,
          name: input.name,
          qrType: input.qrType,
          maxUses: input.maxUses,
          validityMode: input.validityMode,
          startsAt: input.validFrom ? new Date(input.validFrom) : null,
          endsAt: input.validUntil ? new Date(input.validUntil) : null,
          validOn: input.validOn,
          requiresIdCheck: input.requiresIdCheck,
          isActive: input.isActive,
          createdBy: auth.user.id,
        })
        .returning();
      if (!row) throw new ApiError("INTERNAL_ERROR", "Checkpoint creation failed.");
      if (audit)
        await insertAudit(tx, audit, {
          action: "CHECKPOINT_CREATED",
          entityType: "checkpoint",
          entityId: row.id,
          eventId,
          after: {
            name: row.name,
            qrType: row.qrType,
            maxUses: row.maxUses,
            validityMode: row.validityMode,
          },
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "This event already has a counter with that name.");
    throw err;
  }
}

export async function updateCheckpoint(
  checkpointId: string,
  input: z.infer<typeof updateCheckpointSchema>,
  audit?: AuditContext,
) {
  const before = await loadCheckpoint(checkpointId);
  const { db } = getDb();

  // Lowering the limit below what someone already used would make their
  // remaining count negative and rewrite history. Refuse instead. This includes
  // switching a counted QR to ONE_TIME after somebody has scanned twice.
  const nextLimit = qrTypeLimit(input.qrType, input.maxUses);
  if (nextLimit !== null) {
    const [top] = await db
      .select({ n: sql<number>`coalesce(max(${redemptions.useNumber}), 0)::int` })
      .from(redemptions)
      .where(eq(redemptions.checkpointId, checkpointId));
    if ((top?.n ?? 0) > nextLimit)
      throw new ApiError(
        "CONFLICT",
        `A participant has already used this ${top?.n} times; the limit cannot be lower.`,
      );
  }

  // A toggle QR's history is a sequence of in/out pairs. Turning it into a
  // counted or one-time QR would leave those directions meaningless, so the type
  // is fixed once the QR has been used.
  if (input.qrType !== before.qrType) {
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(redemptions)
      .where(eq(redemptions.checkpointId, checkpointId));
    if ((used?.n ?? 0) > 0)
      throw new ApiError(
        "CONFLICT",
        "This QR has already been scanned, so its type cannot change. Create another QR instead.",
      );
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(checkpoints)
        .set({
          name: input.name,
          qrType: input.qrType,
          maxUses: input.maxUses,
          validityMode: input.validityMode,
          startsAt: input.validFrom ? new Date(input.validFrom) : null,
          endsAt: input.validUntil ? new Date(input.validUntil) : null,
          validOn: input.validOn,
          requiresIdCheck: input.requiresIdCheck,
          isActive: input.isActive,
        })
        .where(eq(checkpoints.id, checkpointId))
        .returning();
      if (audit)
        await insertAudit(tx, audit, {
          action: "CHECKPOINT_UPDATED",
          entityType: "checkpoint",
          entityId: checkpointId,
          eventId: before.eventId,
          before: {
            isActive: before.isActive,
            maxUses: before.maxUses,
            name: before.name,
            qrType: before.qrType,
            validityMode: before.validityMode,
          },
          after: {
            name: input.name,
            qrType: input.qrType,
            maxUses: input.maxUses,
            validityMode: input.validityMode,
            isActive: input.isActive,
          },
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "This event already has a QR with that name.");
    throw err;
  }
}

/** The live switch, on its own, so the portal can flip it without a full form. */
export async function setCheckpointActive(
  checkpointId: string,
  isActive: boolean,
  audit?: AuditContext,
) {
  const before = await loadCheckpoint(checkpointId);
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(checkpoints)
      .set({ isActive })
      .where(eq(checkpoints.id, checkpointId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "CHECKPOINT_UPDATED",
        entityType: "checkpoint",
        entityId: checkpointId,
        eventId: before.eventId,
        before: { isActive: before.isActive },
        after: { isActive },
      });
    return row;
  });
}

export async function deleteCheckpoint(checkpointId: string, audit?: AuditContext) {
  const before = await loadCheckpoint(checkpointId);
  const { db } = getDb();
  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(redemptions)
    .where(eq(redemptions.checkpointId, checkpointId));
  const [scanned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scanLogs)
    .where(eq(scanLogs.checkpointId, checkpointId));
  if ((used?.n ?? 0) > 0 || (scanned?.n ?? 0) > 0)
    throw new ApiError(
      "CONFLICT",
      "This counter already has scans, including refused ones. Close it instead of deleting it, so the record survives.",
    );
  return db.transaction(async (tx) => {
    await tx.delete(scanLogs).where(eq(scanLogs.checkpointId, checkpointId));
    await tx.delete(qrNonces).where(eq(qrNonces.checkpointId, checkpointId));
    await tx.delete(checkpoints).where(eq(checkpoints.id, checkpointId));
    if (audit)
      await insertAudit(tx, audit, {
        action: "CHECKPOINT_DELETED",
        entityType: "checkpoint",
        entityId: checkpointId,
        eventId: before.eventId,
        before: { name: before.name },
      });
    return { deleted: true };
  });
}

/**
 * Issue passes for every confirmed participant. Registration is a mobile flow;
 * this lets a coordinator provision passes from the portal today, and is
 * idempotent so it can be pressed again as more people confirm.
 */
export async function issuePasses(eventId: string, audit?: AuditContext) {
  await loadEvent(eventId);
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const confirmed = await tx
      .select({ id: registrations.id })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "CONFIRMED")));
    // One statement, not one per participant: a 500-seat event should not make
    // 500 round trips inside a transaction.
    const inserted = confirmed.length
      ? await tx
          .insert(passes)
          .values(confirmed.map((r) => ({ registrationId: r.id })))
          .onConflictDoNothing()
          .returning({ id: passes.id })
      : [];
    const created = inserted.length;
    if (audit)
      await insertAudit(tx, audit, {
        action: "PASSES_ISSUED",
        entityType: "event",
        entityId: eventId,
        eventId,
        after: { created, confirmed: confirmed.length },
      });
    return { created, confirmed: confirmed.length };
  });
}

/** Everyone holding a pass for the event, with their total scans. */
export async function listPasses(eventId: string) {
  const { db } = getDb();
  const rows = await db
    .select({
      passId: passes.id,
      revokedAt: passes.revokedAt,
      status: registrations.status,
      user: { id: users.id, fullName: users.fullName, email: users.email },
      uses: sql<number>`(SELECT count(*)::int FROM redemptions r WHERE r.pass_id = "passes"."id")`,
    })
    .from(passes)
    .innerJoin(registrations, eq(registrations.id, passes.registrationId))
    .innerJoin(users, eq(users.id, registrations.userId))
    .where(eq(registrations.eventId, eventId))
    .orderBy(asc(users.fullName));
  return rows;
}

export async function accessLog(eventId: string, page: z.infer<typeof accessLogQuerySchema>) {
  const { db } = getDb();
  const filters = [eq(scanLogs.eventId, eventId)];
  if (page.checkpointId) filters.push(eq(scanLogs.checkpointId, page.checkpointId));
  if (page.result) filters.push(eq(scanLogs.result, page.result));
  const rows = await db
    .select({
      log: scanLogs,
      scanner: { id: users.id, fullName: users.fullName },
      checkpointName: checkpoints.name,
      // Name and phone, not just an id: a gate log is read to answer "who came
      // through, and how do I reach them", and an opaque id answers neither.
      participant: {
        id: registrations.userId,
        fullName: participantUser.fullName,
        phone: participantUser.phone,
        email: participantUser.email,
      },
    })
    .from(scanLogs)
    .innerJoin(users, eq(users.id, scanLogs.scannerId))
    .leftJoin(checkpoints, eq(checkpoints.id, scanLogs.checkpointId))
    .leftJoin(passes, eq(passes.id, scanLogs.passId))
    .leftJoin(registrations, eq(registrations.id, passes.registrationId))
    .leftJoin(participantUser, eq(participantUser.id, registrations.userId))
    .where(and(...filters))
    .orderBy(desc(scanLogs.createdAt), desc(scanLogs.id))
    .limit(page.limit + 1)
    .offset(page.offset);
  return {
    items: rows.slice(0, page.limit).map((r) => {
      // nonceHash is the replay guard, not something a reader needs.
      const { nonceHash: _hidden, ...log } = r.log;
      return {
        ...log,
        scanner: r.scanner,
        checkpointName: r.checkpointName,
        participantId: r.participant?.id ?? null,
        participantName: r.participant?.fullName ?? null,
        participantPhone: r.participant?.phone ?? null,
        participantEmail: r.participant?.email ?? null,
      };
    }),
    limit: page.limit,
    offset: page.offset,
    hasMore: rows.length > page.limit,
  };
}

/** The participant's own wallet: one entry per checkpoint, with turns left. */
export async function myPasses(auth: AuthContext) {
  const { db } = getDb();
  const rows = await db
    .select({ pass: passes, registration: registrations, event: events })
    .from(passes)
    .innerJoin(registrations, eq(registrations.id, passes.registrationId))
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(eq(registrations.userId, auth.user.id))
    .orderBy(desc(events.startsAt));

  if (rows.length === 0) return { items: [] };

  // Two queries for the whole wallet, not two per event: a student who has
  // attended a dozen events should not trigger two dozen round trips.
  const eventIds = rows.map((r) => r.event.id);
  const passIds = rows.map((r) => r.pass.id);
  const allCheckpoints = await db
    .select()
    .from(checkpoints)
    .where(inArray(checkpoints.eventId, eventIds))
    .orderBy(asc(checkpoints.createdAt), asc(checkpoints.name));
  const allUses = await db
    .select({
      passId: redemptions.passId,
      checkpointId: redemptions.checkpointId,
      n: sql<number>`count(*)::int`,
    })
    .from(redemptions)
    .where(inArray(redemptions.passId, passIds))
    .groupBy(redemptions.passId, redemptions.checkpointId);
  const usesBy = new Map(allUses.map((u) => [`${u.passId}:${u.checkpointId}`, u.n]));
  const now = new Date();

  const items = rows.map((row) => ({
    passId: row.pass.id,
    publicId: row.pass.publicId,
    revokedAt: row.pass.revokedAt,
    registrationStatus: row.registration.status,
    event: {
      id: row.event.id,
      title: row.event.title,
      status: row.event.status,
      startsAt: row.event.startsAt,
      endsAt: row.event.endsAt,
      venueSummary: row.event.venueSummary,
    },
    checkpoints: allCheckpoints
      .filter((cp) => cp.eventId === row.event.id)
      .map((cp) =>
        standingFor(toAccessQr(cp), usesBy.get(`${row.pass.id}:${cp.id}`) ?? 0, now, {
          eventStatus: row.event.status,
          passRevoked: Boolean(row.pass.revokedAt),
          registrationStatus: row.registration.status,
          timeZone: env.CAMPUS_TIMEZONE,
        }),
      ),
  }));
  return { items };
}

/** Mint a short-lived rotating code for one checkpoint on the caller's own pass. */
export async function mintNonce(auth: AuthContext, passId: string, checkpointId: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ pass: passes, registration: registrations })
    .from(passes)
    .innerJoin(registrations, eq(registrations.id, passes.registrationId))
    .where(eq(passes.id, passId))
    .limit(1);
  if (!row || row.registration.userId !== auth.user.id)
    throw new ApiError("NOT_FOUND", "Pass not found.");
  if (row.pass.revokedAt) throw new ApiError("CONFLICT", "This pass has been revoked.");
  const cp = await loadCheckpoint(checkpointId);
  if (cp.eventId !== row.registration.eventId)
    throw new ApiError("VALIDATION_ERROR", "That counter belongs to a different event.");

  const ttl = env.QR_TTL_SECONDS;
  const expiresAt = Date.now() + ttl * 1000;
  const token = signQrPayload({
    p: row.pass.publicId,
    c: checkpointId,
    e: expiresAt,
    n: newNonce(),
  });
  return {
    token,
    checkpointId,
    expiresAt: new Date(expiresAt).toISOString(),
    refreshAfterSeconds: Math.max(5, ttl - 10),
  };
}

/**
 * Read the pass holder before the organiser attests to an identity match.
 * This does not consume the nonce or record a use; the final scan re-verifies
 * expiry, replay, limits and the switch inside its transaction.
 */
export async function inspectScan(auth: AuthContext, input: z.infer<typeof inspectScanSchema>) {
  const cp = await loadCheckpoint(input.checkpointId);
  const event = await loadEvent(cp.eventId);
  assertMayScan(auth, event.clubId);
  const verified = verifyQrToken(input.token);
  if (!verified.ok)
    throw new ApiError(
      "VALIDATION_ERROR",
      verified.reason === "EXPIRED"
        ? "This code has expired. Ask the participant to refresh it."
        : "This code is not a valid CampusOps pass.",
    );
  const { db } = getDb();
  const [row] = await db
    .select({ user: users, registration: registrations, pass: passes })
    .from(passes)
    .innerJoin(registrations, eq(registrations.id, passes.registrationId))
    .innerJoin(users, eq(users.id, registrations.userId))
    .where(eq(passes.publicId, verified.payload.p))
    .limit(1);
  if (!row || row.registration.eventId !== cp.eventId)
    throw new ApiError("NOT_FOUND", "No pass matches this code for this event.");
  const [profile] = await db
    .select({ collegeIdNumber: studentProfiles.collegeIdNumber })
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, row.user.id))
    .limit(1);
  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(redemptions)
    .where(and(eq(redemptions.passId, row.pass.id), eq(redemptions.checkpointId, cp.id)));
  return {
    participant: {
      id: row.user.id,
      fullName: row.user.fullName,
      email: row.user.email,
      collegeIdNumber: profile?.collegeIdNumber ?? null,
    },
    checkpoint: { id: cp.id, name: cp.name, requiresIdCheck: cp.requiresIdCheck },
    standing: standingFor(toAccessQr(cp), used?.n ?? 0, new Date(), {
      eventStatus: event.status,
      passRevoked: Boolean(row.pass.revokedAt),
      registrationStatus: row.registration.status,
      timeZone: env.CAMPUS_TIMEZONE,
    }),
  };
}

type ScanOutcome = {
  /** True when an offline sync replayed a scan that was already recorded. */
  duplicate?: boolean;
  result: "GRANTED" | "DENIED";
  reason: string;
  message: string;
  checkpoint: { id: string; name: string; qrType: string };
  participant: {
    id: string;
    fullName: string;
    email: string;
    collegeIdNumber: string | null;
  } | null;
  useNumber: number | null;
  remainingAfter: number | null;
  /** For a toggle QR: which way this scan counted. */
  direction: "IN" | "OUT" | null;
};

/**
 * The scan itself. One transaction: look up the pass, lock it, consume the nonce,
 * count prior uses, decide, then write the redemption and the log together. Two
 * coordinators scanning the same participant at once cannot both grant the last
 * meal.
 */
/**
 * Extra context for a scan that was captured without network and synced later.
 * `capturedAt` is when the scanner actually read the code; the decision is
 * evaluated against that instant, while replay and identity state are checked
 * against the live database at sync time.
 */
export type OfflineContext = { clientScanId: string; capturedAt: Date };

export async function scan(
  auth: AuthContext,
  input: z.infer<typeof scanSchema>,
  offline?: OfflineContext,
): Promise<ScanOutcome> {
  const { db } = getDb();
  const cp = await loadCheckpoint(input.checkpointId);
  const event = await loadEvent(cp.eventId);
  assertMayScan(auth, event.clubId);

  // An offline replay of an already-synced scan returns the recorded outcome and
  // changes nothing — this is what makes retrying a queued batch safe.
  if (offline) {
    const [prior] = await db
      .select()
      .from(scanLogs)
      .where(
        and(eq(scanLogs.scannerId, auth.user.id), eq(scanLogs.clientScanId, offline.clientScanId)),
      )
      .limit(1);
    if (prior) {
      return {
        result: prior.result,
        reason: prior.reason,
        message: `Already synced: ${prior.reason}`,
        checkpoint: { id: cp.id, name: cp.name, qrType: cp.qrType as string },
        participant: null,
        useNumber: null,
        remainingAfter: null,
        direction: null,
        duplicate: true,
      };
    }
  }

  const cpInfo = { id: cp.id, name: cp.name, qrType: cp.qrType as string };
  const identityCheck = input.identityCheck as IdentityCheck;
  // Offline: the code must have been valid when it was read, not when it synced.
  const verified = verifyQrToken(input.token, offline ? offline.capturedAt.getTime() : Date.now());
  const offlineFields = offline
    ? { clientScanId: offline.clientScanId, capturedAt: offline.capturedAt, syncedOffline: true }
    : {};
  // Schedule rules are judged at capture time; an event that has since completed
  // was still live when the participant walked in.
  const decisionNow = offline ? offline.capturedAt : new Date();
  const statusNow = effectiveEventStatus(event.status, event.startsAt, event.endsAt, decisionNow);
  // Offline scans captured before the event ended are judged as they were then.
  const eventStatusForDecision =
    offline && statusNow === "COMPLETED" && offline.capturedAt < event.endsAt ? "LIVE" : statusNow;

  // A forged or expired code never reaches the pass lookup, but it is still
  // logged so a coordinator can see repeated attempts at their counter.
  if (!verified.ok) {
    const expired = verified.reason === "EXPIRED";
    await db.insert(scanLogs).values({
      checkpointId: cp.id,
      eventId: cp.eventId,
      scannerId: auth.user.id,
      result: "DENIED",
      reason: expired ? "QR_EXPIRED" : "QR_INVALID",
      identityCheck,
      ...offlineFields,
    });
    return {
      result: "DENIED",
      reason: expired ? "QR_EXPIRED" : "QR_INVALID",
      message: expired
        ? "This code has expired — ask them to refresh it."
        : "This code is not valid. Ask the participant to refresh it.",
      checkpoint: cpInfo,
      participant: null,
      useNumber: null,
      remainingAfter: null,
      direction: null,
    };
  }

  const { payload, nonceHash } = verified;

  // A code minted for another counter is refused WITHOUT consuming its nonce.
  // Otherwise a participant who shows the meal code at the entry gate would find
  // it "already scanned" when they reach the meal counter.
  if (payload.c !== cp.id) {
    await db.insert(scanLogs).values({
      checkpointId: cp.id,
      eventId: cp.eventId,
      scannerId: auth.user.id,
      result: "DENIED",
      reason: "WRONG_CHECKPOINT",
      identityCheck,
      nonceHash,
      ...offlineFields,
    });
    const decision = decideAccess({
      qr: toAccessQr(cp),
      eventStatus: event.status,
      passRevoked: false,
      registrationStatus: "CONFIRMED",
      usedCount: 0,
      identityCheck,
      scannedForQrId: payload.c,
      timeZone: env.CAMPUS_TIMEZONE,
    });
    return {
      result: "DENIED",
      reason: decision.reason,
      message: decision.message,
      checkpoint: cpInfo,
      participant: null,
      useNumber: null,
      remainingAfter: decision.remainingAfter,
      direction: null,
    };
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ pass: passes, registration: registrations, user: users })
      .from(passes)
      .innerJoin(registrations, eq(registrations.id, passes.registrationId))
      .innerJoin(users, eq(users.id, registrations.userId))
      .where(eq(passes.publicId, payload.p))
      .limit(1);

    // A code that matches no pass is refused before any nonce is written:
    // qr_nonces.pass_id is a real foreign key.
    if (!row) {
      await tx.insert(scanLogs).values({
        checkpointId: cp.id,
        eventId: cp.eventId,
        scannerId: auth.user.id,
        result: "DENIED",
        reason: "PASS_NOT_FOUND",
        identityCheck,
        nonceHash,
        ...offlineFields,
      });
      return {
        result: "DENIED",
        reason: "PASS_NOT_FOUND",
        message: "No pass matches this code.",
        checkpoint: cpInfo,
        participant: null,
        useNumber: null,
        remainingAfter: null,
        direction: null,
      };
    }

    const [profile] = await tx
      .select({ collegeIdNumber: studentProfiles.collegeIdNumber })
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, row.user.id))
      .limit(1);
    const participant = {
      id: row.user.id,
      fullName: row.user.fullName,
      email: row.user.email,
      collegeIdNumber: profile?.collegeIdNumber ?? null,
    };

    await tx.select({ id: passes.id }).from(passes).where(eq(passes.id, row.pass.id)).for("update");

    // Inserting the nonce is the replay guard: a second scan of the same code
    // conflicts and is refused even before the code expires.
    const consumed = await tx
      .insert(qrNonces)
      .values({
        nonceHash,
        passId: row.pass.id,
        checkpointId: cp.id,
        expiresAt: new Date(payload.e),
      })
      .onConflictDoNothing()
      .returning({ nonceHash: qrNonces.nonceHash });

    const [countRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(redemptions)
      .where(and(eq(redemptions.passId, row.pass.id), eq(redemptions.checkpointId, cp.id)));

    const decision = decideAccess({
      qr: toAccessQr(cp),
      eventStatus: eventStatusForDecision,
      // A pass revoked AFTER the capture instant was valid when the person entered.
      passRevoked: offline
        ? Boolean(row.pass.revokedAt && row.pass.revokedAt <= offline.capturedAt)
        : Boolean(row.pass.revokedAt),
      registrationStatus: row.registration.status,
      usedCount: countRow?.n ?? 0,
      identityCheck,
      scannedForQrId: payload.c,
      qrReplayed: consumed.length === 0,
      timeZone: env.CAMPUS_TIMEZONE,
      now: decisionNow,
    });

    if (decision.result === "GRANTED" && decision.useNumber !== null) {
      await tx.insert(redemptions).values({
        passId: row.pass.id,
        checkpointId: cp.id,
        scannerId: auth.user.id,
        useNumber: decision.useNumber,
        direction: decision.direction,
        ...(offline ? { clientScanId: offline.clientScanId, capturedAt: offline.capturedAt } : {}),
      });
    }

    await tx.insert(scanLogs).values({
      passId: row.pass.id,
      checkpointId: cp.id,
      eventId: cp.eventId,
      scannerId: auth.user.id,
      result: decision.result,
      reason: decision.reason,
      identityCheck,
      nonceHash,
      ...offlineFields,
    });

    return {
      result: decision.result,
      reason: decision.reason,
      message: decision.message,
      checkpoint: cpInfo,
      participant,
      useNumber: decision.useNumber,
      remainingAfter: decision.remainingAfter,
      direction: decision.direction,
    };
  });
}

/** Revoking a pass stops one participant, not the whole event. */
export async function revokePass(passId: string, audit?: AuditContext) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(passes)
      .set({ revokedAt: new Date() })
      .where(and(eq(passes.id, passId), isNull(passes.revokedAt)))
      .returning();
    if (!row) throw new ApiError("NOT_FOUND", "Pass not found or already revoked.");
    if (audit)
      await insertAudit(tx, audit, {
        action: "PASS_REVOKED",
        entityType: "pass",
        entityId: passId,
      });
    return row;
  });
}

/**
 * Sync a batch of scans captured while the scanner had no network.
 *
 * Guarantees, in order of importance:
 *  1. Idempotent — each scan carries a client-generated id; replaying a batch
 *     returns the recorded outcomes and consumes nothing.
 *  2. Bounded staleness — a scan older than OFFLINE_SCAN_MAX_AGE_MINUTES is
 *     refused, so a phone cannot inject last week's entries.
 *  3. No double counting — the nonce is still single-use, so the same code
 *     queued by two scanners grants once and is reported replayed for the other.
 *  4. Honest attribution — the log records both capturedAt and sync time, and
 *     `syncedOffline` so a report can distinguish live from deferred scans.
 *
 * Each item is processed independently: one bad code does not reject the batch.
 */
export async function syncOfflineScans(
  auth: AuthContext,
  items: Array<{
    clientScanId: string;
    checkpointId: string;
    token: string;
    identityCheck: IdentityCheck;
    capturedAt: string;
  }>,
): Promise<{
  results: Array<{
    clientScanId: string;
    result: "GRANTED" | "DENIED";
    reason: string;
    message: string;
    duplicate: boolean;
    participantName: string | null;
    useNumber: number | null;
    remainingAfter: number | null;
    direction: "IN" | "OUT" | null;
  }>;
  accepted: number;
  refused: number;
}> {
  const now = Date.now();
  const maxAgeMs = env.OFFLINE_SCAN_MAX_AGE_MINUTES * 60_000;
  const results: Array<{
    clientScanId: string;
    result: "GRANTED" | "DENIED";
    reason: string;
    message: string;
    duplicate: boolean;
    participantName: string | null;
    useNumber: number | null;
    remainingAfter: number | null;
    direction: "IN" | "OUT" | null;
  }> = [];
  // A duplicate id inside one batch must not be processed twice.
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.clientScanId)) {
      results.push({
        clientScanId: item.clientScanId,
        result: "DENIED",
        reason: "DUPLICATE_IN_BATCH",
        message: "This scan appeared twice in the same batch.",
        duplicate: true,
        participantName: null,
        useNumber: null,
        remainingAfter: null,
        direction: null,
      });
      continue;
    }
    seen.add(item.clientScanId);
    const capturedAt = new Date(item.capturedAt);
    const age = now - capturedAt.getTime();
    // Allow a small clock skew into the future, never a large one.
    if (Number.isNaN(capturedAt.getTime()) || age > maxAgeMs || age < -300_000) {
      results.push({
        clientScanId: item.clientScanId,
        result: "DENIED",
        reason: "SCAN_TOO_OLD",
        message: `Queued scans must be synced within ${env.OFFLINE_SCAN_MAX_AGE_MINUTES} minutes.`,
        duplicate: false,
        participantName: null,
        useNumber: null,
        remainingAfter: null,
        direction: null,
      });
      continue;
    }
    try {
      const outcome = await scan(
        auth,
        {
          checkpointId: item.checkpointId,
          token: item.token,
          identityCheck: item.identityCheck,
        },
        { clientScanId: item.clientScanId, capturedAt },
      );
      results.push({
        clientScanId: item.clientScanId,
        result: outcome.result,
        reason: outcome.reason,
        message: outcome.message,
        duplicate: Boolean(outcome.duplicate),
        participantName: outcome.participant?.fullName ?? null,
        useNumber: outcome.useNumber ?? null,
        remainingAfter: outcome.remainingAfter ?? null,
        direction: outcome.direction ?? null,
      });
    } catch (err) {
      // A checkpoint the scanner may not use, or one deleted while offline.
      const message = err instanceof ApiError ? err.message : "Could not sync this scan.";
      const reason = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
      results.push({
        clientScanId: item.clientScanId,
        result: "DENIED",
        reason,
        message,
        duplicate: false,
        participantName: null,
        useNumber: null,
        remainingAfter: null,
        direction: null,
      });
    }
  }
  return {
    results,
    accepted: results.filter((r) => r.result === "GRANTED").length,
    refused: results.filter((r) => r.result === "DENIED").length,
  };
}
