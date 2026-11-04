import type { Context, Next } from "hono";
import type { z } from "zod";
import { ApiError } from "../utils/api-error";

export async function parseJson<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Request validation failed.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

export function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Query validation failed.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

export async function withValidation<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  next: Next,
  handler: (data: z.infer<T>) => Promise<Response>,
) {
  const data = await parseJson(c, schema);
  return handler(data);
}
