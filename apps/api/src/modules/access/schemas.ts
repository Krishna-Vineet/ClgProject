import { IDENTITY_CHECK_RESULTS, QR_TYPES, QR_VALIDITY_MODES } from "@campusops/shared";
import { z } from "zod";

const name = z.string().trim().min(1).max(80);
const isoDate = z.string().datetime();
const dayOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-14.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "That calendar date does not exist.");

/**
 * A QR is whatever the coordinator says it is: a name, a type, and when it is
 * accepted. The refinements below mirror the database checks so a bad
 * combination is rejected with a helpful message rather than a 500.
 */
const qrFields = {
  name,
  qrType: z.enum(QR_TYPES),
  /** Required for COUNTED, ignored (and rejected) for the other types. */
  maxUses: z.number().int().min(1).max(1000).nullish(),
  validityMode: z.enum(QR_VALIDITY_MODES),
  validFrom: isoDate.nullish(),
  validUntil: isoDate.nullish(),
  validOn: dayOnly.nullish(),
  requiresIdCheck: z.boolean().default(true),
  isActive: z.boolean().default(true),
};

function refineQr<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema
    .superRefine((v, ctx) => {
      const value = v as Record<string, unknown>;
      if (value.qrType === "COUNTED") {
        if (typeof value.maxUses !== "number")
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["maxUses"],
            message: "Set how many times one participant may scan this QR.",
          });
      } else if (value.maxUses !== undefined && value.maxUses !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxUses"],
          message: "Only a counted QR takes a number of uses.",
        });
      }

      if (value.validityMode === "WINDOW") {
        if (!value.validFrom || !value.validUntil)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["validFrom"],
            message: "Give both a start and an end time.",
          });
        else if (new Date(value.validUntil as string) <= new Date(value.validFrom as string))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["validUntil"],
            message: "The QR must stop being valid after it starts.",
          });
      }
      if (value.validityMode === "DATE" && !value.validOn)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["validOn"],
          message: "Pick the date this QR is valid on.",
        });
      if (value.validityMode === "MANUAL" && (value.validFrom || value.validUntil || value.validOn))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["validityMode"],
          message: "A switch-only QR has no schedule. Remove the times or the date.",
        });
    })
    .transform((v) => {
      const value = v as Record<string, unknown>;
      // Normalise away fields the chosen mode does not use, so the row always
      // satisfies the database check regardless of what the client sent.
      return {
        ...v,
        maxUses: value.qrType === "COUNTED" ? (value.maxUses as number) : null,
        validFrom: value.validityMode === "WINDOW" ? (value.validFrom as string) : null,
        validUntil: value.validityMode === "WINDOW" ? (value.validUntil as string) : null,
        validOn: value.validityMode === "DATE" ? (value.validOn as string) : null,
      };
    });
}

export const createCheckpointSchema = refineQr(z.object(qrFields));

/**
 * Editing sends the whole rule, not a patch. A QR's type and validity mode
 * change which other fields are meaningful, so a partial update could leave an
 * inconsistent combination; the portal always submits the full form.
 */
export const updateCheckpointSchema = refineQr(z.object(qrFields));

/** The live switch on its own, for use during a running event. */
export const setQrActiveSchema = z.object({ isActive: z.boolean() });

export const scanSchema = z.object({
  /** The signed, rotating token from the participant's screen. */
  token: z.string().min(10).max(2000),
  checkpointId: z.string().uuid(),
  identityCheck: z.enum(IDENTITY_CHECK_RESULTS).default("NOT_REQUIRED"),
});

export const inspectScanSchema = z.object({
  token: z.string().min(10).max(2000),
  checkpointId: z.string().uuid(),
});

export const mintNonceSchema = z.object({
  checkpointId: z.string().uuid(),
});

export const accessLogQuerySchema = z.object({
  checkpointId: z.string().uuid().optional(),
  result: z.enum(["GRANTED", "DENIED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/** A batch of scans captured offline. Bounded by OFFLINE_SCAN_BATCH_MAX at the route. */
export const offlineScanItemSchema = z
  .object({
    clientScanId: z.string().uuid(),
    checkpointId: z.string().uuid(),
    // Deliberately not length-validated here: a corrupt entry in an offline
    // queue must be refused per item (QR_INVALID) rather than rejecting the
    // whole batch and blocking every good scan behind it.
    token: z.string().min(1).max(2000),
    identityCheck: z.enum(["MATCH", "MISMATCH", "NOT_REQUIRED"]),
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const syncOfflineScansSchema = z
  .object({ items: z.array(offlineScanItemSchema).min(1).max(200) })
  .strict();
