import { z } from "zod";

export const createDepartmentSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers and hyphens only.")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(160),
});

const programFields = {
  name: z.string().trim().min(2).max(120),
  departmentId: z.string().uuid(),
  foundationDepartmentId: z.string().uuid().nullable().optional(),
  foundationYears: z.number().int().min(0).max(12).default(0),
  durationYears: z.number().int().min(1).max(12).default(4),
};

export const createProgramSchema = z
  .object(programFields)
  .refine((v) => v.foundationYears <= v.durationYears, {
    message: "Foundation years cannot exceed the programme duration.",
    path: ["foundationYears"],
  });

export const updateProgramSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    departmentId: z.string().uuid().optional(),
    foundationDepartmentId: z.string().uuid().nullable().optional(),
    foundationYears: z.number().int().min(0).max(12).optional(),
    durationYears: z.number().int().min(1).max(12).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export const listProgramsQuerySchema = z.object({
  departmentId: z.string().uuid().optional(),
  includeInactive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export const updateDepartmentSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
