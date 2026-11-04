import type { MiddlewareHandler } from "hono";
import { env } from "../config/env";
import { ApiError } from "../utils/api-error";

/**
 * Bound how long one request may hold a connection.
 *
 * Without this, a statement waiting on a row lock (or a pooler hiccup that never
 * answers) keeps its pool slot forever. The pool drains, every later request
 * queues behind the zombies, and the process looks alive while serving nothing.
 * This turns that into a 504 for the one request that is stuck.
 *
 * The timer is cleared on the way out, so the happy path pays nothing but a
 * `setTimeout` registration.
 */
export const requestTimeout = (): MiddlewareHandler => async (c, next) => {
  const ms = env.REQUEST_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new ApiError("REQUEST_TIMEOUT", "This request took too long. Please retry.")),
      ms,
    );
    // Do not keep the process alive just for the guard.
    (timeoutId as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([next(), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};
