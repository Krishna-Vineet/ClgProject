import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES } from "@campusops/shared";
import { z } from "zod";

export const createLocationSchema = z.object({
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullish(),
});

export const updateLocationSchema = z
  .object({
    label: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).nullable(),
    /** Closing a location stops new reports but keeps the ones already raised. */
    revoked: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export const raiseComplaintSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES).default("OTHER"),
  description: z.string().trim().min(5).max(4000),
});

export const updateComplaintSchema = z
  .object({
    status: z.enum(COMPLAINT_STATUSES),
    assignedTo: z.string().uuid().nullable(),
    note: z.string().trim().max(2000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export const complaintListQuerySchema = z.object({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  locationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
