import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const isoDateSchema = z.string().datetime({ offset: true });

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string().optional(),
  }),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("campusops-api"),
  phase: z.number().int().min(0),
  timestamp: z.string(),
  checks: z.object({ database: z.enum(["ok", "unavailable", "not_configured"]) }),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Offset pagination used by every Phase 3 list endpoint. */
export const offsetPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type OffsetPagination = z.infer<typeof offsetPaginationSchema>;

export type OffsetPage<T> = {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
  total?: number;
};

export const timeWindowQuerySchema = z
  .object({
    startsAt: isoDateSchema,
    endsAt: isoDateSchema,
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt.",
    path: ["endsAt"],
  });
