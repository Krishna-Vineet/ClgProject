import type { Context } from "hono";
import type { ApiError } from "./api-error";

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json({ data, requestId: c.get("requestId") }, status as 200);
}

export function fail(c: Context, error: ApiError) {
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
