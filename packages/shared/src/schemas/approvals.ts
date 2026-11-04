import { z } from "zod";
import { APPROVAL_TIERS } from "../constants/roles";
import { isoDateSchema, uuidSchema } from "./common";

/** Optimistic concurrency: every decision must carry the version the approver saw. */
export const expectedVersionSchema = z.number().int().min(1);

export const decisionSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
    comment: z.string().trim().max(4000).optional(),
    expectedVersion: expectedVersionSchema,
  })
  .refine((v) => v.action === "APPROVE" || (v.comment && v.comment.length >= 5), {
    message: "A comment of at least 5 characters is required when rejecting or requesting changes.",
    path: ["comment"],
  });

export const escalateSchema = z.object({
  toTier: z.enum(APPROVAL_TIERS),
  assigneeId: uuidSchema.nullish(),
  comment: z.string().trim().min(5).max(4000),
  expectedVersion: expectedVersionSchema,
});

export const reassignSchema = z.object({
  assigneeId: uuidSchema.nullable(),
  reason: z.string().trim().min(5).max(2000),
  expectedVersion: expectedVersionSchema,
});

export const cancelRequestSchema = z.object({
  reason: z.string().trim().min(5).max(2000),
  expectedVersion: expectedVersionSchema,
});

export const addApprovalRequestSchema = z.object({
  type: z.enum(["ORGANIZE", "INVITE_OUTSIDERS", "RESOURCE_USE", "CUSTOM"]),
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(4000).optional(),
  isRequired: z.boolean().default(true),
  assignedApproverId: uuidSchema.nullish(),
  dueAt: isoDateSchema.nullish(),
  resources: z
    .array(
      z.object({
        resourceUnitId: uuidSchema,
        startsAt: isoDateSchema,
        endsAt: isoDateSchema,
      }),
    )
    .max(20)
    .default([]),
});

export const attachResourcesSchema = z.object({
  expectedVersion: expectedVersionSchema,
  resources: z
    .array(
      z.object({
        resourceUnitId: uuidSchema,
        startsAt: isoDateSchema,
        endsAt: isoDateSchema,
      }),
    )
    .min(1)
    .max(20),
});

export const approvalInboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED", "CANCELLED"]).optional(),
  tier: z.enum(APPROVAL_TIERS).optional(),
  scope: z.enum(["assigned", "queue", "all"]).default("all"),
});

export type DecisionInput = z.infer<typeof decisionSchema>;
export type EscalateInput = z.infer<typeof escalateSchema>;
export type ReassignInput = z.infer<typeof reassignSchema>;
export type AddApprovalRequestInput = z.infer<typeof addApprovalRequestSchema>;
export type ApprovalInboxQuery = z.infer<typeof approvalInboxQuerySchema>;
