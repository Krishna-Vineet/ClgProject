/** Retry a safe database read once after a dropped network connection. */
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECTION_CLOSED",
]);

function hasTransientSocketError(error: unknown): boolean {
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
  return false;
}

/** The callback must be idempotent/read-only; writes must not use this helper. */
export async function retryTransientRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!hasTransientSocketError(error)) throw error;
    // Give the postgres client a moment to evict the broken socket and reconnect.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return read();
  }
}
