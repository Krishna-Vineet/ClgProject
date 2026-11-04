import { and, eq, lt } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { authConfig } from "../config/env";
import { getDb } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { ApiError } from "../utils/api-error";
import { hashToken } from "../utils/tokens";

const IN_PROGRESS_TTL_MS = 2 * 60_000;
const COMPLETED_TTL_MS = 24 * 60 * 60_000;

/**
 * Idempotent writes, with a real reservation instead of check-then-act.
 *
 * The first request inserts an in-progress row under the table's primary key.
 * A concurrent request with the same key loses that insert and returns 409 rather
 * than executing the handler a second time. Once the response is ready the row is
 * completed and replayed for later retries. A crashed request leaves an
 * in-progress row that expires after two minutes, so a key is never wedged.
 */
export function idempotent(scope: string) {
  return createMiddleware(async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!key) return next();
    if (key.length > 200) throw new ApiError("VALIDATION_ERROR", "Idempotency-Key is too long.");

    const cfg = authConfig();
    const actor = c.get("auth")?.user.id ?? "public";
    const body = await c.req.raw.clone().text();
    const requestHash =
      hashToken(`${c.req.method}:${c.req.path}:${actor}:${body}`, cfg.refreshPepper) ?? "";
    const fullScope = `${scope}:${actor}`;
    const { db } = getDb();

    const [claimed] = await db
      .insert(idempotencyKeys)
      .values({
        key,
        scope: fullScope,
        requestHash,
        responseStatus: null,
        responseBody: null,
        completed: false,
        expiresAt: new Date(Date.now() + IN_PROGRESS_TTL_MS),
      })
      .onConflictDoNothing()
      .returning();

    if (!claimed) {
      const [existing] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, fullScope)))
        .limit(1);
      if (!existing)
        throw new ApiError("CONFLICT", "The idempotency record changed. Please retry.");

      if (existing.requestHash !== requestHash)
        throw new ApiError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was used with a different request.",
        );

      if (existing.completed) {
        if (existing.responseStatus === null || existing.responseBody === null)
          throw new ApiError("IDEMPOTENCY_IN_PROGRESS", "This request is still being processed.");
        return c.json(existing.responseBody, existing.responseStatus as 200);
      }

      if (existing.expiresAt.getTime() > Date.now())
        throw new ApiError(
          "IDEMPOTENCY_IN_PROGRESS",
          "The same request is already being processed. Retry in a moment.",
        );

      // The previous attempt died. Take the reservation over atomically.
      const [reclaimed] = await db
        .update(idempotencyKeys)
        .set({
          requestHash,
          completed: false,
          responseStatus: null,
          responseBody: null,
          expiresAt: new Date(Date.now() + IN_PROGRESS_TTL_MS),
        })
        .where(
          and(
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.scope, fullScope),
            lt(idempotencyKeys.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!reclaimed)
        throw new ApiError(
          "IDEMPOTENCY_IN_PROGRESS",
          "The same request is already being processed. Retry in a moment.",
        );
    }

    try {
      await next();
    } catch (err) {
      await db
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, fullScope)));
      throw err;
    }

    const res = c.res;
    if (res.status >= 500) {
      await db
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, fullScope)));
      return;
    }
    const clone = res.clone();
    const json = await clone.json().catch(() => null);
    if (!json) {
      await db
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, fullScope)));
      return;
    }
    await db
      .update(idempotencyKeys)
      .set({
        completed: true,
        responseStatus: res.status,
        responseBody: json,
        expiresAt: new Date(Date.now() + COMPLETED_TTL_MS),
      })
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, fullScope)));
  });
}
