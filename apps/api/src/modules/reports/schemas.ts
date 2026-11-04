import { z } from "zod";

export const generateReportSchema = z.object({
  notes: z.string().trim().max(4000).optional(),
});

export const reportPreviewQuerySchema = z.object({
  notes: z.string().trim().max(4000).optional(),
});

export type GenerateReportInput = z.infer<typeof generateReportSchema>;
