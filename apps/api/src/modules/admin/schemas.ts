import { GLOBAL_ROLES, STAFF_POSITIONS } from "@campusops/shared";
import { z } from "zod";
import { phoneInputSchema } from "../auth/schemas";

export const provisionStaffSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    fullName: z.string().trim().min(2).max(120),
    designation: z.string().trim().min(2).max(120).optional(),
    position: z.enum(STAFF_POSITIONS).optional(),
    employeeCode: z.string().trim().max(60).optional(),
    // null or omitted means institution-wide; a department id scopes the role later.
    departmentId: z.string().uuid().nullable().optional(),
    phone: phoneInputSchema.optional(),
  })
  .refine((v) => Boolean(v.position || v.designation), {
    message: "Choose a staff position.",
    path: ["position"],
  });

export const listStaffSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  q: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
  position: z.enum(STAFF_POSITIONS).optional(),
  status: z
    .enum(["PENDING_EMAIL", "PENDING_VERIFICATION", "ACTIVE", "REJECTED", "SUSPENDED"])
    .optional(),
});

export const grantRoleSchema = z
  .object({
    role: z.enum(GLOBAL_ROLES),
    scopeType: z.enum(["GLOBAL", "DEPARTMENT"]),
    departmentId: z.string().uuid().optional(),
  })
  .refine((v) => v.role !== "ADMIN" || v.scopeType === "GLOBAL", {
    message: "ADMIN must be GLOBAL.",
  })
  .refine((v) => v.scopeType !== "DEPARTMENT" || Boolean(v.departmentId), {
    message: "DEPARTMENT scope requires departmentId.",
  })
  .refine((v) => v.scopeType !== "GLOBAL" || !v.departmentId, {
    message: "GLOBAL scope cannot include departmentId.",
  });

export const suspendSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const reactivateSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(60).optional(),
});

export const listUsersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(120).optional(),
  status: z
    .enum(["PENDING_EMAIL", "PENDING_VERIFICATION", "ACTIVE", "REJECTED", "SUSPENDED"])
    .optional(),
});
