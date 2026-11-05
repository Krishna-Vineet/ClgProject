import { QUIZ_MODES } from "@campusops/shared";
import { z } from "zod";

const isoDate = z.string().datetime({ offset: true });

export const questionSchema = z
  .object({
    prompt: z.string().trim().min(3).max(1000),
    options: z.array(z.string().trim().min(1).max(300)).min(2).max(6),
    correctOptionIndex: z.number().int().min(0).max(5),
    points: z.number().min(0.25).max(100).default(1),
  })
  .strict()
  .refine((q) => q.correctOptionIndex < q.options.length, {
    message: "The correct option must be one of the options.",
    path: ["correctOptionIndex"],
  });

export const createQuizSchema = z
  .object({
    mode: z.enum(QUIZ_MODES),
    opensAt: isoDate,
    closesAt: isoDate,
    durationSeconds: z.number().int().min(30).max(14400),
    /** Percentage 0–100. Required for FIRST_QUALIFIED. */
    passScore: z.number().min(0).max(100).nullable().optional(),
    shuffleQuestions: z.boolean().default(true),
    instructions: z.string().trim().max(2000).default(""),
    /** Defaults to the event capacity when omitted. */
    seats: z.number().int().min(1).max(100000).nullable().optional(),
    questions: z.array(questionSchema).min(1).max(200),
  })
  .strict()
  .refine((q) => new Date(q.closesAt) > new Date(q.opensAt), {
    message: "The quiz must close after it opens.",
    path: ["closesAt"],
  })
  .refine((q) => q.mode !== "FIRST_QUALIFIED" || typeof q.passScore === "number", {
    message: "First-to-qualify needs a pass score.",
    path: ["passScore"],
  });

export const updateQuizSchema = createQuizSchema;

/**
 * DRAFT is absent on purpose: a quiz is created as a draft and only ever leaves
 * it via the open/close-window rules. PAUSED is the reversible middle state.
 */
export const setQuizStatusSchema = z
  .object({ status: z.enum(["PUBLISHED", "PAUSED", "CLOSED"]) })
  .strict();

export const allocateSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

/** Answers are option indexes keyed by question id. Bounded to the question cap. */
export const submitAttemptSchema = z
  .object({
    answers: z.record(z.string().uuid(), z.number().int().min(0).max(5)),
    /** Advisory only; the server clock decides expiry. */
    clientSubmittedAt: isoDate.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v.answers).length <= 200, {
    message: "Too many answers.",
    path: ["answers"],
  });

export const leaderboardQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();

export type CreateQuizInput = z.infer<typeof createQuizSchema>;
export type SubmitAttemptInput = z.infer<typeof submitAttemptSchema>;
