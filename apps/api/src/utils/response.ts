import type { Context } from "hono";
import type { ApiError } from "./api-error";

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json({ data, requestId: c.get("requestId") }, status as 200);
}

export function fail(c: Context, error: ApiError) {
  // Tell a client *when* to come back, so "retry" is actionable instead of a
  // guess. Only for the transient families; a validation error is not a wait.
  if (error.code === "DATABASE_BUSY" || error.code === "DATABASE_CONNECTION_LOST") {
    c.header("Retry-After", "2");
  } else if (error.code === "REQUEST_TIMEOUT") {
    c.header("Retry-After", "5");
  }
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        requestId: c.get("requestId"),
      },
    },
    error.status as 400,
  );
}
