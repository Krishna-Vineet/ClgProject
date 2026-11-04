import type { ErrorHandler } from "hono";
import { ApiError } from "../utils/api-error";
import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  pgCode,
  pgDetail,
} from "../utils/db-error";
import { hasTransientSocketError } from "../utils/db-retry";
import { log } from "../utils/logger";
import { fail } from "../utils/response";

/**
 * Turn database failures into the same structured envelope as domain errors.
 *
 * Application code validates first, but two concurrent requests can still race a
 * unique constraint, a check can fire on a hand-built row, and an exclusion can
 * reject an overlapping booking. Those are client-visible conflicts, not 500s.
 */
function databaseError(err: unknown): ApiError | null {
  if (isUniqueViolation(err))
    return new ApiError("CONFLICT", "A record with these details already exists.");
  if (isCheckViolation(err))
    return new ApiError("VALIDATION_ERROR", "A value in this request is not allowed.");
  if (isForeignKeyViolation(err))
    return new ApiError("CONFLICT", "This record is still referenced by other data.");
  if (isExclusionViolation(err))
    return new ApiError("RESOURCE_CONFLICT", "That booking overlaps an existing reservation.");

  const code = pgCode(err);
  if (code === "22P02" || code === "22007" || code === "22008")
    return new ApiError("VALIDATION_ERROR", "Invalid identifier or date format.");
  if (code === "40001" || code === "40P01")
    return new ApiError("CONFLICT", "The record changed while you were working. Please retry.");
  if (code === "53300" || code === "08003" || code === "08006")
    return new ApiError(
      "DATABASE_UNAVAILABLE",
      "The database is briefly unavailable. Retry shortly.",
    );
  // A pooled host closed the backend mid-request. It reaches here only after the
  // retry in utils/db-retry gave up, so say what actually happened rather than
  // reporting an unexplained 500 — and make the retry advice specific.
  if (hasTransientSocketError(err))
    return new ApiError(
      "DATABASE_CONNECTION_LOST",
      "The connection to the database dropped while this request was in flight. Nothing was saved twice; please try again.",
    );
  // The code was updated before the database was. That is an operator problem,
  // not an unexplained 500: name the fix so the person running the server can act.
  if (code === "42703" || code === "42P01" || code === "42883")
    return new ApiError(
      "DATABASE_SCHEMA_OUT_OF_DATE",
      "The service database is missing a required update. An administrator must run the pending migrations and restart the API.",
    );
  return null;
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) return fail(c, err);

  const dbError = databaseError(err);
  if (dbError) return fail(c, dbError);

  log.error("request_failed", {
    requestId: c.get("requestId") ?? null,
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
    dbCode: pgCode(err),
    dbDetail: pgDetail(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return fail(c, new ApiError("INTERNAL_ERROR", "An unexpected error occurred."));
};
