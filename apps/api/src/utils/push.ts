import { and, eq, inArray } from "drizzle-orm";
import { env } from "../config/env";
import { getDb } from "../db/client";
import { notificationDevices, pushDeliveries } from "../db/schema";

/**
 * Expo push delivery.
 *
 * Modes mirror email: `disabled` records nothing, `demo` logs and records a
 * delivery row so the flow is reviewable without a real Expo project, and `expo`
 * posts to the real Expo Push API. Nothing here throws for a single bad device —
 * an unregistered token is deactivated so it stops being retried forever.
 */

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

type ExpoTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo tokens look like ExponentPushToken[...] or ExpoPushToken[...]. */
export function isExpoPushToken(token: string): boolean {
  return /^Ex(?:po|ponent)PushToken\[[A-Za-z0-9_-]{8,}\]$/.test(token);
}

export type PushDispatchResult = {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  deactivated: number;
};

/**
 * Deliver one outbox message to one user's active devices. The unique
 * (outbox_id, device_id) index makes this safe to call again after a partial
 * failure: already-sent devices are skipped rather than notified twice.
 */
export async function deliverPushForOutbox(input: {
  outboxId: string;
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<PushDispatchResult> {
  const result: PushDispatchResult = {
    attempted: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    deactivated: 0,
  };
  if (env.PUSH_MODE === "disabled") return result;
  const { db } = getDb();
  const devices = await db
    .select()
    .from(notificationDevices)
    .where(
      and(eq(notificationDevices.userId, input.userId), eq(notificationDevices.isActive, true)),
    )
    .limit(env.PUSH_MAX_DEVICES_PER_USER);
  if (devices.length === 0) return result;

  const prior = await db
    .select()
    .from(pushDeliveries)
    .where(
      and(
        eq(pushDeliveries.outboxId, input.outboxId),
        inArray(
          pushDeliveries.deviceId,
          devices.map((d) => d.id),
        ),
      ),
    );
  const done = new Set(prior.filter((p) => p.status === "SENT").map((p) => p.deviceId));

  for (const device of devices) {
    if (done.has(device.id)) {
      result.skipped += 1;
      continue;
    }
    result.attempted += 1;
    if (!isExpoPushToken(device.expoPushToken)) {
      await db
        .insert(pushDeliveries)
        .values({
          outboxId: input.outboxId,
          deviceId: device.id,
          status: "SKIPPED",
          error: "Not an Expo push token.",
        })
        .onConflictDoNothing();
      result.skipped += 1;
      continue;
    }
    if (env.PUSH_MODE === "demo") {
      await db
        .insert(pushDeliveries)
        .values({
          outboxId: input.outboxId,
          deviceId: device.id,
          status: "SENT",
          ticketId: `demo-${input.outboxId.slice(0, 8)}-${device.id.slice(0, 8)}`,
        })
        .onConflictDoNothing();
      console.log(`[push:demo] ${device.platform} ${input.title}`);
      result.sent += 1;
      continue;
    }

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify([
          {
            to: device.expoPushToken,
            title: input.title.slice(0, 120),
            body: input.body.slice(0, 500),
            data: input.data ?? {},
            sound: "default",
            channelId: "default",
          },
        ]),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Expo push HTTP ${response.status}`);
      const json = (await response.json()) as { data?: ExpoTicket[] };
      const ticket = json.data?.[0];
      if (!ticket) throw new Error("Expo push returned no ticket.");
      if (ticket.status === "error") {
        const code = ticket.details?.error ?? "UnknownError";
        // DeviceNotRegistered means the app was uninstalled: stop targeting it.
        if (code === "DeviceNotRegistered") {
          await db
            .update(notificationDevices)
            .set({ isActive: false })
            .where(eq(notificationDevices.id, device.id));
          result.deactivated += 1;
        }
        await db
          .insert(pushDeliveries)
          .values({
            outboxId: input.outboxId,
            deviceId: device.id,
            status: "FAILED",
            error: `${code}: ${ticket.message ?? ""}`.slice(0, 500),
          })
          .onConflictDoNothing();
        result.failed += 1;
        continue;
      }
      await db
        .insert(pushDeliveries)
        .values({
          outboxId: input.outboxId,
          deviceId: device.id,
          status: "SENT",
          ticketId: ticket.id ?? null,
        })
        .onConflictDoNothing();
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "Push delivery failed";
      await db
        .insert(pushDeliveries)
        .values({
          outboxId: input.outboxId,
          deviceId: device.id,
          status: "FAILED",
          error: message,
        })
        .onConflictDoNothing();
      result.failed += 1;
    }
  }
  return result;
}
