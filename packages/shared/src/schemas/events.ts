import { z } from "zod";
import { ADMISSION_MODES, EVENT_AUDIENCES, EVENT_TEMPLATES } from "../constants/events";
import { isoDateSchema, uuidSchema } from "./common";
import { eligibilityPolicySchema } from "./eligibility";

/**
 * Event contracts shared by API and web.
 * The DB owns the final invariants; these give fast, readable 400s.
 */

const title = z.string().trim().min(3).max(180);
const description = z.string().trim().max(8000);

export const eventWindowSchema = z.object({
  startsAt: isoDateSchema,
  endsAt: isoDateSchema,
  registrationOpensAt: isoDateSchema,
  registrationClosesAt: isoDateSchema,
});

export const createEventSchema = eventWindowSchema.extend({
  clubId: uuidSchema,
  title,
  description: description.default(""),
  template: z.enum(EVENT_TEMPLATES).default("CUSTOM"),
  audience: z.enum(EVENT_AUDIENCES).default("COLLEGE_ONLY"),
  admissionMode: z.enum(ADMISSION_MODES).default("FCFS"),
  capacity: z.number().int().min(1).max(100_000),
  eligibilityPolicy: eligibilityPolicySchema.default({ version: 1 }),
  venueSummary: z.string().trim().max(300).nullish(),
  onlineMeetingUrl: z.string().url().max(500).nullish(),
  jobDescription: z.string().trim().max(20_000).nullish(),
  bannerFileId: uuidSchema.nullish(),
});

export const updateEventSchema = createEventSchema
  .omit({ clubId: true })
  .partial()
  .extend({ expectedRevision: z.number().int().min(1) });

export const submitEventSchema = z.object({
  expectedRevision: z.number().int().min(1),
  note: z.string().trim().max(2000).optional(),
  requests: z
    .array(
      z.object({
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
      }),
    )
    .min(1)
    .max(20),
});

export const publishEventSchema = z.object({
  expectedRevision: z.number().int().min(1),
});

export const cancelEventSchema = z.object({
  reason: z.string().trim().min(5).max(2000),
});

/**
 * Completing an event takes no report reference: reports are generated from the
 * recorded facts via POST /events/:id/reports, not uploaded by the caller.
 * `reportFileId` was previously accepted here and silently discarded.
 */
export const completeEventSchema = z.object({}).strict();

export const reviseEventSchema = z.object({
  expectedRevision: z.number().int().min(1),
  note: z.string().trim().max(2000).optional(),
});

export const inviteSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(254)).min(1).max(200),
  expiresAt: isoDateSchema.nullish(),
});

export const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  status: z
    .enum(["DRAFT", "PENDING_APPROVALS", "READY", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"])
    .optional(),
  q: z.string().trim().max(120).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type SubmitEventInput = z.infer<typeof submitEventSchema>;
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
