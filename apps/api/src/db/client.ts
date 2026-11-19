import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env, runtimeDatabaseUrl } from "../config/env";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof createDb>;

/**
 * Connection settings for a hosted pooler (Neon, PgBouncer, Supabase).
 *
 * A pooler silently closes idle backends. Without a keep-alive the socket looks
 * usable until the next statement is written to it, which then fails with
 * `write CONNECTION_CLOSED` — after the request has already been waiting. Short
 * idle recycling plus TCP keep-alive means the client discards a stale socket
 * before handing it to a request instead of during one.
 */
const POOLED_OPTIONS = {
  // Recycle our own side well inside a pooler's idle window. Short idle recycling
  // is the cheapest guard against a pooler that closed the backend first.
  idle_timeout: 5,
  connect_timeout: 10,
  // Milliseconds of TCP keep-alive probing (postgres.js expects a number).
  keep_alive: 10_000,
  // Server-side ceilings, so a lock wait cannot outlive the request that owns it
  // even if the client-side guard were removed. statement_timeout is milliseconds.
  connection: {
    statement_timeout: env.REQUEST_TIMEOUT_MS,
    idle_in_transaction_session_timeout: env.REQUEST_TIMEOUT_MS * 2,
    // A lock wait is the one failure a request can usually just retry. Bounding
    // it separately from statement_timeout is what turns a 20-second 504 into a
    // one-second 503 with Retry-After — see middleware/error-handler.
    lock_timeout: env.DB_LOCK_TIMEOUT_MS,
  },
} as const;

export function createDb(connectionString: string, max = env.DB_POOL_MAX) {
  const pooled =
    connectionString.includes("-pooler.") || connectionString === env.DATABASE_URL_POOLED;
  const sql = postgres(connectionString, {
    max,
    ...POOLED_OPTIONS,
    // Neon transaction pooling is safest without client-side prepared statements.
    // A statement prepared on one pooled backend fails on the next one.
    prepare: !pooled,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

let defaultClient: DbClient | null = null;

export function getDb(connectionString?: string): DbClient {
  if (connectionString) return createDb(connectionString);
  const url = runtimeDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL or DATABASE_URL_POOLED is not configured.");
  defaultClient ??= createDb(url);
  return defaultClient;
}

/**
 * Test hook: drop the cached pool so the next `getDb()` re-reads the environment.
 * Returns the client that was cached, so the caller can close it.
 */
export function resetDbCache(): DbClient | null {
  const previous = defaultClient;
  defaultClient = null;
  return previous;
}

export async function closeDb(client: DbClient): Promise<void> {
  await client.sql.end({ timeout: 5 });
}

/**
 * Race a unit of work against an abort signal.
 *
 * The request-timeout guard aborts the signal when it gives up on a request.
 * Without this, the abandoned work keeps its transaction, its row locks and its
 * pool slot, so a single timed-out write starves every later request on a small
 * pool — the reason one slow approval decision turned into 504s everywhere.
 * Rejecting *inside* the transaction callback makes Drizzle roll back, which
 * hands the connection back and releases the locks immediately.
 */
export function raceAbort<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
