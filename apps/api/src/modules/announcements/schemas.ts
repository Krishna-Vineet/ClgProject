import { ANNOUNCEMENT_AUDIENCES } from "@campusops/shared";
import { z } from "zod";

export const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(3).max(160),
    body: z.string().trim().min(3).max(4000),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES).default("REGISTERED"),
    isPinned: z.boolean().default(false),
    /** Also queue a push notification to registered devices. */
    push: z.boolean().default(true),
  })
  .strict();

export const announcementListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();

export const registerDeviceSchema = z
  .object({
    expoPushToken: z.string().trim().min(10).max(200),
    platform: z.enum(["ios", "android", "web"]),
  })
  .strict();

export const removeDeviceSchema = z
  .object({ expoPushToken: z.string().trim().min(10).max(200) })
  .strict();

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
