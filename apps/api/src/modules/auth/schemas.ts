import { z } from "zod";
import { normalizePhone } from "../../utils/phone";

export const phoneInputSchema = z
  .string()
  .trim()
  .max(30)
  .refine((value) => normalizePhone(value) !== null, "Enter a valid phone number.")
  .transform((value) => normalizePhone(value) as string);

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(128);
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const clientSchema = z.enum(["web", "mobile"]).default("web");
export const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "OTP must be 6 digits.");

export const registerCollegeSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    fullName: z.string().trim().min(2).max(120),
    phone: phoneInputSchema.optional(),
    consentAccepted: z.boolean().optional(),
    institutionName: z.string().trim().min(2).max(160),
    rollNumber: z.string().trim().min(1).max(40),
    // departmentId stays for older clients; programme-aware clients send programId.
    departmentId: z.string().uuid().optional(),
    programId: z.string().uuid().optional(),
    studyYear: z.number().int().min(1).max(12).optional(),
    program: z.string().trim().max(120).optional(),
    graduationYear: z.number().int().min(2000).max(2100).optional(),
    collegeIdNumber: z.string().trim().max(60).optional(),
    client: clientSchema,
  })
  .refine((v) => Boolean(v.departmentId || v.programId), {
    message: "Choose a department or programme.",
    path: ["departmentId"],
  });

export const registerOutsiderSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  phone: phoneInputSchema.optional(),
  consentAccepted: z.boolean().optional(),
  institutionName: z.string().trim().min(2).max(160),
  program: z.string().trim().max(120).optional(),
  graduationYear: z.number().int().min(2000).max(2100).optional(),
  client: clientSchema,
});

export const verifyEmailSchema = z.union([
  z.object({ token: z.string().min(20).max(200) }),
  z.object({ challengeId: z.string().uuid(), otp: otpSchema }),
]);
export const resendVerificationSchema = z.object({ email: emailSchema });
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  client: clientSchema,
  deviceLabel: z.string().max(120).optional(),
});
export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(200).optional(),
  client: clientSchema,
});
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.union([
  z.object({ token: z.string().min(20).max(200), newPassword: passwordSchema }),
  z.object({ email: emailSchema, otp: otpSchema, newPassword: passwordSchema }),
]);
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const updateMeSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: phoneInputSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

export const deleteAccountSchema = z.object({
  // Typing the address is the deliberate-action check; there is no undo.
  confirmEmail: emailSchema,
});
