import { z } from "zod";
import { RESOURCE_STATUSES } from "../constants/events";
import { isoDateSchema, uuidSchema } from "./common";

export const createResourceSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).nullish(),
  departmentId: uuidSchema.nullish(),
  capacity: z.number().int().min(1).max(100_000).nullish(),
  metadata: z.record(z.unknown()).default({}),
  unitLabels: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
});

export const updateResourceSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(4000).nullish(),
  status: z.enum(RESOURCE_STATUSES).optional(),
  capacity: z.number().int().min(1).max(100_000).nullish(),
  departmentId: uuidSchema.nullish(),
  metadata: z.record(z.unknown()).optional(),
});

export const createUnitSchema = z.object({
  label: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(2000).nullish(),
});

export const updateUnitSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  status: z.enum(RESOURCE_STATUSES).optional(),
  notes: z.string().trim().max(2000).nullish(),
});

export const resourceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  departmentId: uuidSchema.optional(),
  status: z.enum(RESOURCE_STATUSES).optional(),
  q: z.string().trim().max(120).optional(),
});

export const availabilityQuerySchema = z.object({
  startsAt: isoDateSchema,
  endsAt: isoDateSchema,
  departmentId: uuidSchema.optional(),
  resourceId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const calendarQuerySchema = z.object({
  startsAt: isoDateSchema,
  endsAt: isoDateSchema,
  resourceId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
});

export type CreateResourceInput = z.infer<typeof createResourceSchema>;
export type UpdateResourceInput = z.infer<typeof updateResourceSchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
