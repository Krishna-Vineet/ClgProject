/**
 * Retry a database operation after a dropped network connection.
 *
 * Neon's pooler (and any PgBouncer-style pooler) recycles idle backend sockets
 * without telling the client. The client-side pool in `postgres` keeps handing
 * out the dead socket, so the failure lands on whichever request happens to pick
 * it up — which is why it looks like "this one API is broken" when in fact the
 * request that pays the price is random.
 *
 * Writes need the same treatment as reads, but only when the retry is safe:
 *  - a transient socket error means the statement never reached the server, so
 *    replaying it cannot apply anything twice;
 *  - an open transaction whose BEGIN already committed a socket error mid-flight
 *    is a different story, which is why transactions opt in explicitly.
 */
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/** Errors raised by the pool when it has no usable connection at all. */
function isPoolExhausted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // postgres.js reports a connection timeout / pool rejection with these.
  const code = (error as { code?: unknown }).code;
  return code === "CONNECT_TIMEOUT";
}

export function hasTransientSocketError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && TRANSIENT_SOCKET_CODES.has(code)) return true;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return (
    isPoolExhausted(error) ||
    (typeof error === "object" && error !== null && isPoolExhausted(current))
  );
}

/** How many times a dropped connection is retried before the caller sees it. */
const MAX_ATTEMPTS = 3;

/** Backoff between attempts; a pooler needs a moment to hand out a fresh socket. */
const delay = (attempt: number) => new Promise((r) => setTimeout(r, 150 * attempt));

/**
 * Re-run `operation` when it fails with a transient socket error.
 *
 * `safe` must be true only for read-only work, or for writes that are naturally
 * idempotent (row already absent, upsert, insert guarded by a unique key). The
 * default is deliberately conservative: callers opt in.
 */
export async function retryOnConnectionLoss<T>(
  operation: () => Promise<T>,
  options: { safe: boolean; attempts?: number },
): Promise<T> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // A semantic failure (validation, conflict, 404) must never be retried,
      // and a write that may have partially applied must not be replayed.
      if (!options.safe || !hasTransientSocketError(error) || attempt === attempts) throw error;
      await delay(attempt);
    }
  }
  throw lastError;
}

/** The callback must be idempotent/read-only; writes must not use this helper. */
export async function retryTransientRead<T>(read: () => Promise<T>): Promise<T> {
  return retryOnConnectionLoss(read, { safe: true });
}

/**
 * Retry a whole transaction.
 *
 * Safe only because postgres.js rolls the transaction back when the connection
 * dies: nothing it did survives, so replaying it from BEGIN cannot double-apply.
 * If the failure happens after COMMIT was sent the client cannot know whether it
 * landed, so a committed-marked error is never retried.
 */
export async function retryTransaction<T>(run: () => Promise<T>): Promise<T> {
  return retryOnConnectionLoss(run, { safe: true });
}
