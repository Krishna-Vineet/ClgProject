import { and, eq, gt, inArray, lt, lte } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  events,
  approvalActions,
  approvalRequests,
  idempotencyKeys,
  jobRuns,
  notificationOutbox,
  resourceReservations,
} from "../db/schema";
import { syncEventApprovalState } from "../modules/approvals/service";
import { runOutboxJob } from "../modules/notifications/outbox";

/**
 * Operational jobs. Each job is idempotent and uses an advisory lock so multiple
 * API instances (or a cron trigger plus the in-process timer) never double-process.
 */

async function withJobLock<T>(job: string, fn: () => Promise<T>): Promise<T | null> {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ locked: boolean }>(
      // hashtext gives a stable 32-bit key per job name.
      `select pg_try_advisory_xact_lock(hashtext('campusops:job:${job}')) as locked`,
    );
    const locked = Array.isArray(rows)
      ? rows[0]?.locked
      : (rows as unknown as { locked: boolean }[])[0]?.locked;
    if (!locked) return null;
    return fn();
  });
}

export type HoldExpiryResult = { expired: number; requestsFlagged: number };

/**
 * Expire stale HELD reservations. Confirmed bookings are never touched.
 * The affected approval request goes back to CHANGES_REQUESTED so the coordinator
 * sees why the resource is no longer reserved.
 */
export async function expireResourceHolds(): Promise<HoldExpiryResult> {
  const { db } = getDb();
  const result: HoldExpiryResult = { expired: 0, requestsFlagged: 0 };
  await db.transaction(async (tx) => {
    const stale = await tx
      .select()
      .from(resourceReservations)
      .where(
        and(
          eq(resourceReservations.status, "HELD"),
          lte(resourceReservations.holdExpiresAt, new Date()),
        ),
      )
      .for("update", { skipLocked: true });
    if (stale.length === 0) return;
    const ids = stale.map((r) => r.id);
    await tx
      .update(resourceReservations)
      .set({
        status: "EXPIRED",
        releasedAt: new Date(),
        releaseReason: "Hold expired before approval.",
      })
      .where(inArray(resourceReservations.id, ids));
    result.expired = ids.length;

    const requestIds = [...new Set(stale.map((r) => r.requestId))];
    const openRequests = await tx
      .select()
      .from(approvalRequests)
      .where(and(inArray(approvalRequests.id, requestIds), eq(approvalRequests.status, "PENDING")));
    for (const request of openRequests) {
      await tx
        .update(approvalRequests)
        .set({
          status: "CHANGES_REQUESTED",
          version: request.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(approvalRequests.id, request.id));
      await tx.insert(approvalActions).values({
        requestId: request.id,
        actorId: request.createdBy,
        action: "REQUEST_CHANGES",
        fromTier: request.currentTier,
        toTier: request.currentTier,
        fromStatus: "PENDING",
        toStatus: "CHANGES_REQUESTED",
        comment: "System: the resource hold expired before approval. Request the resource again.",
        requestVersion: request.version,
      });
      result.requestsFlagged += 1;
    }
    const eventIds = [...new Set(stale.map((r) => r.eventId))];
    for (const eventId of eventIds) await syncEventApprovalState(tx, eventId);
  });
  return result;
}

export type LifecycleResult = { started: number; completed: number };

/** Move published events to LIVE, and finished events to COMPLETED. */
export async function advanceEventLifecycle(): Promise<LifecycleResult> {
  const { db } = getDb();
  const result: LifecycleResult = { started: 0, completed: 0 };
  const now = new Date();
  await db.transaction(async (tx) => {
    const toStart = await tx
      .select()
      .from(events)
      .where(and(eq(events.status, "PUBLISHED"), lte(events.startsAt, now), gt(events.endsAt, now)))
      .for("update", { skipLocked: true });
    for (const event of toStart) {
      await tx
        .update(events)
        .set({ status: "LIVE", updatedAt: now })
        .where(eq(events.id, event.id));
      result.started += 1;
    }
    const toComplete = await tx
      .select()
      .from(events)
      .where(and(inArray(events.status, ["PUBLISHED", "LIVE"]), lte(events.endsAt, now)))
      .for("update", { skipLocked: true });
    for (const event of toComplete) {
      await tx
        .update(events)
        .set({ status: "COMPLETED", completedAt: now, updatedAt: now })
        .where(eq(events.id, event.id));
      await tx
        .update(resourceReservations)
        .set({ status: "RELEASED", releasedAt: now, releaseReason: "Event completed." })
        .where(
          and(
            eq(resourceReservations.eventId, event.id),
            inArray(resourceReservations.status, ["HELD", "CONFIRMED"]),
          ),
        );
      result.completed += 1;
    }
  });
  return result;
}

/**
 * Housekeeping: delivered outbox rows, stale rate-limit buckets and spent access
 * QR nonces.
 *
 * A busy event mints a code per participant per minute, so qr_nonces is the
 * fastest-growing table in the system. Only nonces that expired over an hour ago
 * are removed: replay protection must outlive the code itself, and the grace
 * period keeps recent evidence available for a dispute at the gate.
 */
export async function pruneOperationalTables(): Promise<{
  outbox: number;
  rateLimits: number;
  qrNonces: number;
  idempotencyKeys: number;
}> {
  const { db } = getDb();
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const deletedOutbox = await db
    .delete(notificationOutbox)
    .where(
      and(
        inArray(notificationOutbox.status, ["SENT", "SKIPPED"]),
        lt(notificationOutbox.createdAt, cutoff),
      ),
    )
    .returning({ id: notificationOutbox.id });
  const { rateLimitBuckets } = await import("../db/schema");
  const deletedBuckets = await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.expiresAt, new Date()))
    .returning({ key: rateLimitBuckets.keyHash });
  const { qrNonces } = await import("../db/schema");
  const nonceCutoff = new Date(Date.now() - 3_600_000);
  const deletedNonces = await db
    .delete(qrNonces)
    .where(lt(qrNonces.expiresAt, nonceCutoff))
    .returning({ nonceHash: qrNonces.nonceHash });
  const deletedIdempotency = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .returning({ key: idempotencyKeys.key });
  return {
    outbox: deletedOutbox.length,
    rateLimits: deletedBuckets.length,
    qrNonces: deletedNonces.length,
    idempotencyKeys: deletedIdempotency.length,
  };
}

export type MaintenanceResult = {
  holds: HoldExpiryResult | null;
  lifecycle: LifecycleResult | null;
  outbox: Awaited<ReturnType<typeof runOutboxJob>> | null;
  skipped: string[];
};

/** One maintenance pass. Safe to call from a timer or an external cron endpoint. */
export async function runMaintenance(): Promise<MaintenanceResult> {
  const { db } = getDb();
  const skipped: string[] = [];
  const [run] = await db.insert(jobRuns).values({ job: "maintenance" }).returning();

  const holds = await withJobLock("expire-holds", expireResourceHolds);
  if (!holds) skipped.push("expire-holds");
  const lifecycle = await withJobLock("event-lifecycle", advanceEventLifecycle);
  if (!lifecycle) skipped.push("event-lifecycle");
  const outbox = await withJobLock("outbox", runOutboxJob);
  if (!outbox) skipped.push("outbox");

  const processed =
    (holds?.expired ?? 0) +
    (lifecycle?.started ?? 0) +
    (lifecycle?.completed ?? 0) +
    (outbox?.processed ?? 0);
  if (run) {
    await db
      .update(jobRuns)
      .set({
        finishedAt: new Date(),
        processed,
        detail: { holds, lifecycle, outbox, skipped },
      })
      .where(eq(jobRuns.id, run.id));
  }
  return { holds, lifecycle, outbox, skipped };
}
