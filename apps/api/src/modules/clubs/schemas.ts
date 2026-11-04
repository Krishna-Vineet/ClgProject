import { CLUB_ROLES } from "@campusops/shared";
import { z } from "zod";

export const createClubSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(1000).optional(),
  departmentId: z.string().uuid().optional(),
});

export const updateClubSchema = createClubSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export const addMemberSchema = z.object({
  userId: z.string().uuid(),
  clubRole: z.enum(CLUB_ROLES).default("COORDINATOR"),
});

export const updateMemberSchema = z
  .object({
    clubRole: z.enum(CLUB_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

/**
 * Member lookup for club managers. Requires a real query so the endpoint cannot
 * be used to enumerate the student body, and returns only what a picker needs.
 */
export const candidateQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(25).default(10),
  /** When adding club faculty, only faculty accounts are offered. */
  role: z.enum(CLUB_ROLES).optional(),
});
