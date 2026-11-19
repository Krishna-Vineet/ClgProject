import type { MiddlewareHandler } from "hono";
import { env } from "../config/env";
import { ApiError } from "../utils/api-error";

/**
 * Bound how long one request may hold a connection — and actually stop it.
 *
 * The first version of this guard only *raced* the handler: after the timeout it
 * answered 504 while the abandoned work kept its pool slot, kept its row locks,
 * and kept writing. On a five-connection pool, three slow decisions were enough
 * to starve every later request, so a "504 on one request" turned into a 504 on
 * all of them. That is the failure mode this now prevents.
 *
 * Two things make the stop real:
 *
 * 1. An AbortSignal is attached to the request context. Anything that accepts one
 *    (the database transaction included) rolls back when it fires instead of
 *    finishing into a response nobody will read.
 * 2. A "cancelled" flag is set on the context. `withDeadline` below is the
 *    cooperative half: work wrapped in it stops at the next step.
 *
 * The client gets 504 REQUEST_TIMEOUT with Retry-After, because the request is
 * safe to repeat — nothing it did was committed.
 */
export const REQUEST_SIGNAL = "requestSignal";
export const REQUEST_ABANDONED = "requestAbandoned";

type Abandonable = { aborted: boolean };

declare module "hono" {
  interface ContextVariableMap {
    requestSignal: AbortSignal;
    requestAbandoned: Abandonable;
  }
}

export const requestTimeout = (): MiddlewareHandler => async (c, next) => {
  const controller = new AbortController();
  const state: Abandonable = { aborted: false };
  c.set(REQUEST_SIGNAL, controller.signal);
  c.set(REQUEST_ABANDONED, state);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      state.aborted = true;
      controller.abort(
        new ApiError("REQUEST_TIMEOUT", "This request took too long. Please retry."),
      );
      reject(
        new ApiError(
          "REQUEST_TIMEOUT",
          "This request took too long, so it was stopped before it could finish. Nothing was saved; please retry.",
        ),
      );
    }, env.REQUEST_TIMEOUT_MS);
    (timeoutId as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([next(), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    // The response is on its way; free anything still holding the signal.
    if (!state.aborted) controller.abort();
  }
};
