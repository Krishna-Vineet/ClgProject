import { TIER_ROLE } from "@campusops/shared";
import type { ApprovalTier } from "@campusops/shared";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { env } from "../../config/env";
import type { DbClient } from "../../db/client";
import { getDb } from "../../db/client";
import { jobRuns, notificationOutbox, roleAssignments, users } from "../../db/schema";
import { deliverNotificationEmail } from "../../utils/email";
import { deliverPushForOutbox } from "../../utils/push";

type Tx = Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0];

/**
 * Transactional outbox. Business transactions only enqueue rows; delivery happens
 * after commit so a slow or failing provider can never roll back a business change
 * or hold a DB transaction open.
 */
export type QueueNotificationInput = {
  kind: string;
  recipientUserId?: string | null | undefined;
  /** When no individual is assigned, notify every active holder of this tier's role. */
  fallbackTier?: ApprovalTier | undefined;
  eventId?: string | null | undefined;
  approvalRequestId?: string | null | undefined;
  subject: string;
  body: string;
  payload?: Record<string, unknown>;
};

export async function queueNotification(tx: Tx, input: QueueNotificationInput) {
  if (!env.NOTIFICATIONS_ENABLED) return [];

  const recipients: Array<{ id: string | null; email: string }> = [];
  if (input.recipientUserId) {
    const [user] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, input.recipientUserId))
      .limit(1);
    if (user) recipients.push(user);
  } else if (input.fallbackTier) {
    const holders = await tx
      .select({ id: users.id, email: users.email })
      .from(roleAssignments)
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(
        and(
          eq(roleAssignments.role, TIER_ROLE[input.fallbackTier]),
          eq(roleAssignments.isActive, true),
          eq(users.status, "ACTIVE"),
        ),
      )
      .limit(env.OUTBOX_FANOUT_MAX);
    recipients.push(...holders);
  }
  if (recipients.length === 0) return [];

  const seen = new Set<string>();
  const rows = recipients.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return tx
    .insert(notificationOutbox)
    .values(
      rows.map((r) => ({
        kind: input.kind,
        recipientUserId: r.id,
        recipientEmail: r.email.toLowerCase(),
        subject: input.subject,
        body: input.body,
        payload: input.payload ?? {},
        eventId: input.eventId ?? null,
        approvalRequestId: input.approvalRequestId ?? null,
        status: "PENDING" as const,
      })),
    )
    .returning();
}

export type DispatchResult = {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Messages that reached at least one device by push. */
  pushed: number;
};

/**
 * Dispatch pending notifications. Safe to run repeatedly; each row is claimed with
 * FOR UPDATE SKIP LOCKED so multiple workers never send the same message twice.
 */
export async function dispatchOutbox(limit = env.OUTBOX_BATCH_SIZE): Promise<DispatchResult> {
  const result: DispatchResult = { processed: 0, sent: 0, failed: 0, skipped: 0, pushed: 0 };
  let pushSent = 0;
  if (!env.NOTIFICATIONS_ENABLED) return result;
  const { db } = getDb();

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, "PENDING"),
          lte(notificationOutbox.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(notificationOutbox.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    // Mark attempts immediately so a crash mid-send does not silently retry forever.
    for (const row of rows) {
      await tx
        .update(notificationOutbox)
        .set({ attempts: row.attempts + 1 })
        .where(eq(notificationOutbox.id, row.id));
    }
    return rows;
  });

  for (const row of claimed) {
    result.processed += 1;
    pushSent = 0;
    try {
      const delivery = await deliverNotificationEmail({
        to: row.recipientEmail,
        subject: row.subject,
        text: row.body,
      });
      // Push rides the same outbox row. A push failure must not fail the email
      // (or vice versa): the row is SENT if either channel delivered, and the
      // per-device push_deliveries table records exactly what happened.
      if (row.recipientUserId && env.PUSH_MODE !== "disabled") {
        try {
          const push = await deliverPushForOutbox({
            outboxId: row.id,
            userId: row.recipientUserId,
            title: row.subject,
            body: row.body,
            data: { ...(row.payload as Record<string, unknown>), kind: row.kind },
          });
          if (push.sent > 0) pushSent += 1;
        } catch (pushErr) {
          console.error(
            "[outbox] push delivery failed",
            pushErr instanceof Error ? pushErr.message : pushErr,
          );
        }
      }
      result.pushed += pushSent;
      if (delivery === "SKIPPED" && pushSent === 0) {
        result.skipped += 1;
        await db
          .update(notificationOutbox)
          .set({ status: "SKIPPED", lastError: "No email provider configured." })
          .where(eq(notificationOutbox.id, row.id));
      } else {
        result.sent += 1;
        await db
          .update(notificationOutbox)
          .set({
            status: "SENT",
            sentAt: new Date(),
            lastError: delivery === "SKIPPED" ? "Email skipped; delivered by push." : null,
          })
          .where(eq(notificationOutbox.id, row.id));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "Unknown delivery error";
      const attempts = row.attempts + 1;
      const exhausted = attempts >= env.OUTBOX_MAX_ATTEMPTS;
      if (exhausted) result.failed += 1;
      const backoffSeconds = Math.min(3600, 30 * 2 ** Math.min(attempts, 6));
      await db
        .update(notificationOutbox)
        .set({
          status: exhausted ? "FAILED" : "PENDING",
          lastError: message,
          nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
        })
        .where(eq(notificationOutbox.id, row.id));
    }
  }
  return result;
}

/** Run the dispatcher and record the run for operational visibility. */
export async function runOutboxJob(): Promise<DispatchResult> {
  const { db } = getDb();
  const [run] = await db.insert(jobRuns).values({ job: "outbox-dispatch" }).returning();
  const result = await dispatchOutbox();
  if (run) {
    await db
      .update(jobRuns)
      .set({ finishedAt: new Date(), processed: result.processed, detail: { ...result } })
      .where(eq(jobRuns.id, run.id));
  }
  return result;
}
