import { z } from "zod";
import { phoneInputSchema } from "../auth/schemas";

export const rejectSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const listStudentsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  q: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
  status: z
    .enum(["PENDING_EMAIL", "PENDING_VERIFICATION", "ACTIVE", "REJECTED", "SUSPENDED"])
    .optional(),
});
export const verifySchema = z.object({ note: z.string().trim().max(500).optional() });
export const profilePatchSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: phoneInputSchema.nullable().optional(),
    institutionName: z.string().trim().min(2).max(160).optional(),
    rollNumber: z.string().trim().min(1).max(40).nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    programId: z.string().uuid().nullable().optional(),
    studyYear: z.number().int().min(1).max(12).nullable().optional(),
    program: z.string().trim().max(120).nullable().optional(),
    graduationYear: z.number().int().min(2000).max(2100).nullable().optional(),
    collegeIdNumber: z.string().trim().max(60).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });
