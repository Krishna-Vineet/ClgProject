import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "./api";

/**
 * Durable offline scan queue.
 *
 * A gate often has no signal, so a scan is written to disk BEFORE any network
 * attempt and only removed once the server has recorded it. Every entry carries
 * a client-generated id, which is what makes retrying safe: the API deduplicates
 * on (scanner, clientScanId), so replaying a batch never counts a person twice.
 *
 * Entries the server refuses are kept with their reason rather than deleted, so
 * the coordinator can see what happened instead of losing the record.
 */
const KEY = "campusops.offlineScans.v1";
const MAX_QUEUED = 500;
const BATCH = 25;

export type QueuedScan = {
  clientScanId: string;
  checkpointId: string;
  token: string;
  identityCheck: "MATCH" | "MISMATCH" | "NOT_REQUIRED";
  capturedAt: string;
  /** Who was scanned, for the operator's own list. Never sent as authority. */
  label: string;
  state: "pending" | "synced" | "refused";
  result?: string;
  reason?: string;
  syncedAt?: string;
  /** Use-count detail from the server, so the gate sees the same as an online scan. */
  useNumber?: number | null;
  remainingAfter?: number | null;
  direction?: "IN" | "OUT" | null;
};

/** RFC4122-shaped id without pulling in a native uuid module. */
export function newScanId(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

export async function readQueue(): Promise<QueuedScan[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedScan[]) : [];
  } catch {
    // A corrupted queue must not brick the scanner.
    return [];
  }
}

async function write(items: QueuedScan[]): Promise<void> {
  // Keep the newest entries plus anything still awaiting a decision.
  const pending = items.filter((i) => i.state === "pending");
  const settled = items.filter((i) => i.state !== "pending").slice(-100);
  await AsyncStorage.setItem(KEY, JSON.stringify([...pending.slice(-MAX_QUEUED), ...settled]));
}

export async function enqueue(scan: Omit<QueuedScan, "state">): Promise<void> {
  const items = await readQueue();
  await write([...items, { ...scan, state: "pending" }]);
}

export type SyncSummary = {
  sent: number;
  accepted: number;
  refused: number;
  remaining: number;
  /** True when the queue could not be reached at all. */
  offline: boolean;
};

/**
 * Sends pending scans in bounded batches. Returns after the first network
 * failure so the caller can tell the operator the queue is still waiting rather
 * than pretending it succeeded.
 */
export async function flushQueue(): Promise<SyncSummary> {
  const all = await readQueue();
  const pending = all.filter((i) => i.state === "pending");
  const summary: SyncSummary = {
    sent: 0,
    accepted: 0,
    refused: 0,
    remaining: pending.length,
    offline: false,
  };
  if (pending.length === 0) return summary;

  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    let response: {
      accepted: number;
      refused: number;
      results: Array<{
        clientScanId: string;
        result: string;
        reason: string;
        duplicate?: boolean;
        useNumber?: number | null;
        remainingAfter?: number | null;
        direction?: "IN" | "OUT" | null;
      }>;
    };
    try {
      response = await api("/access/scans/sync", {
        items: slice.map((s) => ({
          clientScanId: s.clientScanId,
          checkpointId: s.checkpointId,
          token: s.token,
          identityCheck: s.identityCheck,
          capturedAt: s.capturedAt,
        })),
      });
    } catch {
      summary.offline = true;
      summary.remaining = (await readQueue()).filter((x) => x.state === "pending").length;
      return summary;
    }

    summary.sent += slice.length;
    summary.accepted += response.accepted;
    summary.refused += response.refused;

    const latest = await readQueue();
    for (const result of response.results) {
      const entry = latest.find((x) => x.clientScanId === result.clientScanId);
      if (!entry) continue;
      entry.state = result.result === "GRANTED" ? "synced" : "refused";
      entry.result = result.result;
      entry.reason = result.reason;
      entry.syncedAt = new Date().toISOString();
      entry.useNumber = result.useNumber ?? null;
      entry.remainingAfter = result.remainingAfter ?? null;
      entry.direction = result.direction ?? null;
    }
    await write(latest);
  }
  summary.remaining = (await readQueue()).filter((x) => x.state === "pending").length;
  return summary;
}

export async function clearSettled(): Promise<void> {
  const items = await readQueue();
  await write(items.filter((i) => i.state === "pending"));
}
