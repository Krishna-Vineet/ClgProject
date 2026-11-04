import { DEFAULT_CAMPUS_TIMEZONE, DEFAULT_QR_TTL_SECONDS } from "@campusops/shared";
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const boolFromEnv = (defaultValue: boolean) =>
  z.preprocess((v) => {
    if (v === "" || v === undefined) return defaultValue;
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return v;
  }, z.boolean());

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    WEB_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().default("http://localhost:5173")),
    APP_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default("http://localhost:5173")),
    MOBILE_SCHEME: z.preprocess(emptyToUndefined, z.string().default("campusops")),
    CAMPUS_TIMEZONE: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_CAMPUS_TIMEZONE)),
    INSTITUTION_NAME: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(2).max(160).default("Campus"),
    ),
    QR_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(DEFAULT_QR_TTL_SECONDS),
    // Optional: lets QR signing rotate independently of session signing. When
    // unset the key is derived from JWT_ACCESS_SECRET with a distinct label.
    QR_SIGNING_SECRET: z.string().min(32).optional(),
    // Multiplies every rate-limit ceiling. Keep at 1 in production. Raise it for
    // a local test session or a browser suite, where dozens of logins legitimately
    // come from one address and would otherwise trip the sign-in limit.
    RATE_LIMIT_SCALE: z.coerce.number().int().min(1).max(1000).default(1),
    // Deep link encoded in the printable complaint QR. The mobile app claims it.
    COMPLAINT_QR_BASE: z.string().min(3).default("campusops://complaint"),
    TRUST_PROXY_HEADERS: boolFromEnv(false),
    // How many reverse proxies sit in front of the API. Used to pick the client
    // address out of X-Forwarded-For instead of trusting the whole chain.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),

    // Neon: runtime prefers the pooled URL; migrations prefer the direct URL.
    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    DATABASE_URL_POOLED: z.preprocess(emptyToUndefined, z.string().url().optional()),
    DATABASE_DIRECT_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    TEST_DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
    // Apply pending SQL migrations before the server starts. On by default for
    // local development; production runs migrations as an explicit deploy step
    // (or sets AUTO_MIGRATE=true when it has a direct, non-pooled connection).
    AUTO_MIGRATE: boolFromEnv(process.env.NODE_ENV !== "production"),
    // Reserved for a future Neon Auth integration. CampusOps currently uses its own auth.
    NEON_AUTH_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

    JWT_ACCESS_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    REFRESH_TOKEN_PEPPER: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

    // Explicit demo toggles. Demo OTP exposure is never enabled by provider-key absence alone.
    DEMO_MODE: boolFromEnv(false),
    ALLOW_PRODUCTION_DEMO: boolFromEnv(false),
    EMAIL_MODE: z.enum(["demo", "brevo", "resend"]).optional(),
    EXPOSE_DEMO_OTP: boolFromEnv(false),
    SEED_DEMO_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(10).max(128).optional()),

    EMAIL_FROM: z.preprocess(
      emptyToUndefined,
      z.string().default("CampusOps <no-reply@example.com>"),
    ),
    BREVO_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    // Backwards-compatible generic key; prefer the provider-specific variable.
    EMAIL_PROVIDER_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),

    // Private object storage. Disabled is explicit; s3 requires the full variable group.
    STORAGE_MODE: z.enum(["disabled", "s3"]).default("disabled"),
    AWS_ENDPOINT_URL_S3: z.preprocess(emptyToUndefined, z.string().url().optional()),
    AWS_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    AWS_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    AWS_REGION: z.preprocess(emptyToUndefined, z.string().default("auto")),
    S3_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
    S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    // Phase 3: resource holds and notification outbox
    RESOURCE_HOLD_TTL_HOURS: z.coerce.number().int().min(1).max(336).default(72),
    // Push notifications. "demo" records deliveries without contacting Expo, so
    // the announcement flow is reviewable before an Expo project exists.
    PUSH_MODE: z.enum(["disabled", "demo", "expo"]).default("disabled"),
    PUSH_MAX_DEVICES_PER_USER: z.coerce.number().int().min(1).max(20).default(5),
    EXPO_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),

    // Offline scan sync: how stale a queued scan may be and how many per request.
    OFFLINE_SCAN_MAX_AGE_MINUTES: z.coerce.number().int().min(1).max(1440).default(180),
    OFFLINE_SCAN_BATCH_MAX: z.coerce.number().int().min(1).max(200).default(50),
    // Extra grace on a queued scan's QR expiry. The nonce is still single-use.
    OFFLINE_SCAN_GRACE_SECONDS: z.coerce.number().int().min(0).max(600).default(120),

    NOTIFICATIONS_ENABLED: boolFromEnv(true),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(25),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    JOBS_ENABLED: boolFromEnv(false),
    JOB_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    // Free hosts sleep, so a minute-by-minute cron is not realistic. When this is
    // on, maintenance runs in the background at most once per interval, triggered
    // by ordinary API traffic. Cron remains optional, never required.
    MAINTENANCE_ON_REQUEST: boolFromEnv(true),
    MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    // Optional bearer for an external scheduler. Unset disables the endpoint.
    JOB_RUN_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32).max(200).optional()),
    // Operational caps that used to be literals inside services.
    OUTBOX_FANOUT_MAX: z.coerce.number().int().min(1).max(500).default(50),
    INVITATION_LIST_MAX: z.coerce.number().int().min(1).max(5000).default(500),
    RESOURCE_AVAILABILITY_MAX_UNITS: z.coerce.number().int().min(1).max(2000).default(200),
    APPROVER_DIRECTORY_MAX: z.coerce.number().int().min(1).max(2000).default(200),
    // Attendee rows embedded in one report. Counts stay exact via SQL aggregates;
    // the listed rows are capped and the report says so rather than lying.
    REPORT_MAX_ATTENDEES: z.coerce.number().int().min(1).max(20000).default(2000),

    // JSON logs in production make request ids searchable; pretty logs locally.
    LOG_JSON: boolFromEnv(process.env.NODE_ENV === "production"),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(25 * 1024 * 1024)
      .default(5 * 1024 * 1024),
  })
  .superRefine((e, ctx) => {
    const add = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const productionDemo = e.NODE_ENV === "production" && e.DEMO_MODE;
    if (productionDemo && !e.ALLOW_PRODUCTION_DEMO) {
      add("ALLOW_PRODUCTION_DEMO", "Production demo requires explicit ALLOW_PRODUCTION_DEMO=true.");
    }
    if (
      e.NODE_ENV === "production" &&
      !e.DEMO_MODE &&
      e.EMAIL_MODE !== "resend" &&
      !(e.BREVO_API_KEY || e.EMAIL_PROVIDER_API_KEY)
    ) {
      add(
        "BREVO_API_KEY",
        "Production defaults to Brevo; configure BREVO_API_KEY or explicitly select Resend.",
      );
    }
    if (e.EMAIL_MODE === "demo" && !e.DEMO_MODE) {
      add("EMAIL_MODE", "EMAIL_MODE=demo requires DEMO_MODE=true.");
    }
    if (e.EXPOSE_DEMO_OTP && (e.EMAIL_MODE !== "demo" || !e.DEMO_MODE)) {
      add("EXPOSE_DEMO_OTP", "Demo OTP exposure requires DEMO_MODE=true and EMAIL_MODE=demo.");
    }
    if (e.SEED_DEMO_PASSWORD && !e.DEMO_MODE) {
      add("SEED_DEMO_PASSWORD", "Demo seed password requires DEMO_MODE=true.");
    }
    if (e.PUSH_MODE === "demo" && !e.DEMO_MODE) {
      add("PUSH_MODE", "PUSH_MODE=demo requires DEMO_MODE=true.");
    }
    if (e.NODE_ENV === "production" && e.PUSH_MODE === "demo" && !e.ALLOW_PRODUCTION_DEMO) {
      add("PUSH_MODE", "Production refuses PUSH_MODE=demo unless ALLOW_PRODUCTION_DEMO=true.");
    }
    if (e.EMAIL_MODE === "brevo" && !(e.BREVO_API_KEY || e.EMAIL_PROVIDER_API_KEY)) {
      add("BREVO_API_KEY", "EMAIL_MODE=brevo requires BREVO_API_KEY.");
    }
    if (e.EMAIL_MODE === "resend" && !(e.RESEND_API_KEY || e.EMAIL_PROVIDER_API_KEY)) {
      add("RESEND_API_KEY", "EMAIL_MODE=resend requires RESEND_API_KEY.");
    }
    if (e.STORAGE_MODE === "s3") {
      for (const key of [
        "AWS_ENDPOINT_URL_S3",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "S3_BUCKET",
      ] as const) {
        if (!e[key]) add(key, `STORAGE_MODE=s3 requires ${key}.`);
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export const env = readEnv();

export function runtimeDatabaseUrl(e: Env = env): string | undefined {
  return e.DATABASE_URL_POOLED ?? e.DATABASE_URL;
}

export function migrationDatabaseUrl(e: Env = env): string {
  const url = e.DATABASE_DIRECT_URL ?? e.DATABASE_URL ?? e.DATABASE_URL_POOLED;
  if (!url)
    throw new Error(
      "DATABASE_URL, DATABASE_URL_POOLED or DATABASE_DIRECT_URL is required for migrations.",
    );
  return url;
}

export type AuthConfig = {
  accessSecret: string;
  refreshPepper: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
};

export function authConfig(e: Env = env): AuthConfig {
  if (!e.JWT_ACCESS_SECRET || !e.REFRESH_TOKEN_PEPPER) {
    throw new Error("JWT_ACCESS_SECRET and REFRESH_TOKEN_PEPPER must be configured for auth.");
  }
  return {
    accessSecret: e.JWT_ACCESS_SECRET,
    refreshPepper: e.REFRESH_TOKEN_PEPPER,
    accessTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    otpTtlSeconds: e.OTP_TTL_SECONDS,
    otpMaxAttempts: e.OTP_MAX_ATTEMPTS,
  };
}

export function effectiveEmailMode(e: Env = env): "demo" | "brevo" | "resend" | null {
  if (e.EMAIL_MODE) return e.EMAIL_MODE;
  if (e.DEMO_MODE) return "demo";
  return e.NODE_ENV === "production" ? "brevo" : null;
}

export function isDevEmailMode(e: Env = env): boolean {
  return effectiveEmailMode(e) === "demo" && e.DEMO_MODE;
}

export function shouldExposeDemoOtp(e: Env = env): boolean {
  return isDevEmailMode(e) && e.EXPOSE_DEMO_OTP;
}

export type StorageConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  signedUrlTtlSeconds: number;
  uploadMaxBytes: number;
};

export function storageConfig(e: Env = env): StorageConfig | null {
  if (e.STORAGE_MODE !== "s3") return null;
  if (!e.AWS_ENDPOINT_URL_S3 || !e.AWS_ACCESS_KEY_ID || !e.AWS_SECRET_ACCESS_KEY || !e.S3_BUCKET) {
    throw new Error("STORAGE_MODE=s3 requires the full S3 environment group.");
  }
  return {
    endpoint: e.AWS_ENDPOINT_URL_S3,
    accessKeyId: e.AWS_ACCESS_KEY_ID,
    secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
    region: e.AWS_REGION,
    bucket: e.S3_BUCKET,
    signedUrlTtlSeconds: e.S3_SIGNED_URL_TTL_SECONDS,
    uploadMaxBytes: e.UPLOAD_MAX_BYTES,
  };
}
