import { randomUUID } from "node:crypto";
import { CONSENT_POLICY } from "@campusops/shared";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import { authConfig, runtimeDatabaseUrl, shouldExposeDemoOtp } from "../../config/env";
import { type DbClient, closeDb, createDb, getDb } from "../../db/client";
import {
  authTokens,
  clubMemberships,
  clubs,
  complaints,
  departments,
  passes,
  programs,
  registrations,
  roleAssignments,
  sessions,
  studentProfiles,
  users,
} from "../../db/schema";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { retryTransientRead } from "../../utils/db-retry";
import { sendAuthEmail } from "../../utils/email";
import { signAccessToken } from "../../utils/jwt";
import { hashPassword, verifyPassword } from "../../utils/password";
import { generateOpaqueToken, generateOtp, hashToken, safeEqual } from "../../utils/tokens";
import { effectiveDepartmentId } from "../departments/service";
import type {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerCollegeSchema,
  registerOutsiderSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "./schemas";

const EMAIL_VERIFY_TTL_MIN = 60 * 24;
const RESET_TTL_MIN = 30;
type Purpose = "EMAIL_VERIFICATION" | "PASSWORD_RESET" | "STAFF_SETUP";

export type AuthChallenge = {
  challengeId: string;
  expiresAt: Date;
  delivery: "DEMO" | "SENT" | "FAILED";
  demoOtp?: string;
};

async function createAuthToken(userId: string, purpose: Purpose, ttlMinutes: number) {
  const cfg = authConfig();
  const token = generateOpaqueToken();
  const otp = generateOtp();
  const ttlSeconds = Math.min(ttlMinutes * 60, cfg.otpTtlSeconds);
  const { db } = getDb();
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
      ),
    );
  const [row] = await db
    .insert(authTokens)
    .values({
      userId,
      purpose,
      tokenHash: hashToken(token, cfg.refreshPepper),
      otpHash: hashToken(`${purpose}:${userId}:${otp}`, cfg.refreshPepper),
      maxAttempts: cfg.otpMaxAttempts,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      lastSentAt: new Date(),
    })
    .returning();
  if (!row) throw new ApiError("INTERNAL_ERROR", "Auth challenge creation failed.");
  return { row, token, otp, ttlSeconds };
}

async function dispatchChallenge(
  row: typeof authTokens.$inferSelect,
  to: string,
  subject: string,
  path: string,
  token: string,
  otp: string,
  ttlSeconds: number,
): Promise<AuthChallenge> {
  const { db } = getDb();
  try {
    const email = await sendAuthEmail({ to, subject, path, token, otp, ttlSeconds });
    await db
      .update(authTokens)
      .set({ deliveryStatus: email.delivery })
      .where(eq(authTokens.id, row.id));
    return {
      challengeId: row.id,
      expiresAt: row.expiresAt,
      delivery: email.delivery,
      ...(email.demoOtp ? { demoOtp: email.demoOtp } : {}),
    };
  } catch (err) {
    await db.update(authTokens).set({ deliveryStatus: "FAILED" }).where(eq(authTokens.id, row.id));
    console.error("auth email delivery failed", err instanceof Error ? err.message : "unknown");
    return { challengeId: row.id, expiresAt: row.expiresAt, delivery: "FAILED" };
  }
}

async function consumeByToken(
  token: string,
  purposes: Purpose[],
  database: DbClient["db"] = getDb().db,
) {
  const cfg = authConfig();
  const db = database;
  const [row] = await db
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token, cfg.refreshPepper)),
        isNull(authTokens.consumedAt),
      ),
    )
    .limit(1);
  if (!row || !purposes.includes(row.purpose))
    throw new ApiError("TOKEN_INVALID", "Invalid token.");
  if (row.expiresAt.getTime() < Date.now())
    throw new ApiError("TOKEN_EXPIRED", "Token has expired.");
  const [consumed] = await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.consumedAt)))
    .returning();
  if (!consumed) throw new ApiError("TOKEN_INVALID", "Invalid token.");
  return consumed;
}

async function consumeByOtp(
  challengeId: string,
  otp: string,
  purposes: Purpose[],
  email?: string,
  database: DbClient["db"] = getDb().db,
  rawClient?: DbClient["sql"],
) {
  const cfg = authConfig();
  const db = database;
  let row: typeof authTokens.$inferSelect | undefined;
  if (email) {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw new ApiError("TOKEN_INVALID", "Invalid code.");
    row = await retryTransientRead(async () => {
      if (rawClient) {
        // Use the same parameterized postgres.js path as the passing direct
        // probe. This avoids Drizzle's pooled SELECT path for this one lookup.
        const purposeSlots = purposes.map((_, index) => `$${index + 2}`).join(", ");
        const [latest] = await rawClient.unsafe(
          `select id, user_id as "userId", purpose, token_hash as "tokenHash", otp_hash as "otpHash", attempts, max_attempts as "maxAttempts", last_sent_at as "lastSentAt", delivery_status as "deliveryStatus", expires_at as "expiresAt", consumed_at as "consumedAt", created_at as "createdAt" from auth_tokens where user_id = $1 and purpose in (${purposeSlots}) and consumed_at is null and expires_at > now() order by created_at desc limit 1`,
          [user.id, ...purposes],
        );
        if (!latest) return undefined;
        // postgres.js unsafe() returns timestamptz columns as strings here;
        // Drizzle normally hydrates these as Date objects.
        const expiresAt =
          latest.expiresAt instanceof Date ? latest.expiresAt : new Date(String(latest.expiresAt));
        return { ...latest, expiresAt } as unknown as typeof authTokens.$inferSelect;
      }
      const [latest] = await db
        .select()
        .from(authTokens)
        .where(
          and(
            eq(authTokens.userId, user.id),
            inArray(authTokens.purpose, purposes),
            isNull(authTokens.consumedAt),
            gt(authTokens.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(authTokens.createdAt))
        .limit(1);
      return latest;
    });
    if (!row || !purposes.includes(row.purpose))
      throw new ApiError("TOKEN_INVALID", "Invalid code.");
  } else {
    row = await retryTransientRead(async () => {
      const [challenge] = await db
        .select()
        .from(authTokens)
        .where(and(eq(authTokens.id, challengeId), isNull(authTokens.consumedAt)))
        .limit(1);
      return challenge;
    });
  }
  if (!row || !purposes.includes(row.purpose)) throw new ApiError("TOKEN_INVALID", "Invalid code.");
  if (row.expiresAt.getTime() < Date.now())
    throw new ApiError("TOKEN_EXPIRED", "Code has expired.");
  if (row.attempts >= row.maxAttempts)
    throw new ApiError("TOKEN_INVALID", "Code attempt limit reached.");
  const [attempt] = await db
    .update(authTokens)
    .set({ attempts: row.attempts + 1 })
    .where(
      and(
        eq(authTokens.id, row.id),
        isNull(authTokens.consumedAt),
        eq(authTokens.attempts, row.attempts),
      ),
    )
    .returning();
  if (!attempt) throw new ApiError("TOKEN_INVALID", "Invalid code.");
  const expected = hashToken(`${row.purpose}:${row.userId}:${otp}`, cfg.refreshPepper);
  if (!row.otpHash || !safeEqual(expected, row.otpHash))
    throw new ApiError("TOKEN_INVALID", "Invalid code.");
  const [consumed] = await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.consumedAt)))
    .returning();
  if (!consumed) throw new ApiError("TOKEN_INVALID", "Invalid code.");
  return consumed;
}

export async function createStaffSetupChallenge(userId: string, email: string) {
  const challenge = await createAuthToken(userId, "STAFF_SETUP", 72 * 60);
  return dispatchChallenge(
    challenge.row,
    email,
    "Set up your CampusOps staff account",
    "/staff-setup",
    challenge.token,
    challenge.otp,
    challenge.ttlSeconds,
  );
}

export async function registerCollege(input: z.infer<typeof registerCollegeSchema>) {
  const { db } = getDb();
  const program = input.programId
    ? (await db.select().from(programs).where(eq(programs.id, input.programId)).limit(1))[0]
    : undefined;
  if (input.programId && !program) throw new ApiError("VALIDATION_ERROR", "Programme not found.");
  if (program && !program.isActive)
    throw new ApiError("VALIDATION_ERROR", "That programme is not accepting registrations.");
  if (program && input.studyYear && input.studyYear > program.durationYears)
    throw new ApiError("VALIDATION_ERROR", "Study year is beyond the programme duration.");
  if (program && program.foundationYears > 0 && !input.studyYear)
    throw new ApiError(
      "VALIDATION_ERROR",
      "Select your year of study so your department membership is correct.",
    );
  const departmentId = program
    ? effectiveDepartmentId(program, input.studyYear ?? null)
    : input.departmentId;
  if (!departmentId)
    throw new ApiError(
      "VALIDATION_ERROR",
      "This programme has no department yet. Contact your administrator.",
    );
  const [dept] = await db
    .select()
    .from(departments)
    .where(eq(departments.id, departmentId))
    .limit(1);
  if (!dept) throw new ApiError("VALIDATION_ERROR", "Department not found.");
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          accountType: "COLLEGE_STUDENT",
          status: "PENDING_EMAIL",
          fullName: input.fullName,
          phone: input.phone ?? null,
          consentAcceptedAt: input.consentAccepted ? new Date() : null,
          consentVersion: input.consentAccepted ? CONSENT_POLICY.version : null,
          passwordUpdatedAt: new Date(),
        })
        .returning();
      if (!u) throw new ApiError("INTERNAL_ERROR", "User creation failed.");
      await tx.insert(studentProfiles).values({
        userId: u.id,
        studentKind: "COLLEGE_STUDENT",
        institutionName: input.institutionName,
        rollNumber: input.rollNumber,
        departmentId,
        programId: program?.id ?? null,
        program: input.program ?? program?.name ?? null,
        studyYear: input.studyYear ?? null,
        graduationYear: input.graduationYear ?? null,
        collegeIdNumber: input.collegeIdNumber ?? null,
      });
      return u;
    });
    const challenge = await createAuthToken(user.id, "EMAIL_VERIFICATION", EMAIL_VERIFY_TTL_MIN);
    const verification = await dispatchChallenge(
      challenge.row,
      user.email,
      "Verify your CampusOps email",
      "/verify-email",
      challenge.token,
      challenge.otp,
      challenge.ttlSeconds,
    );
    return { user: publicUser(user), verification };
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("EMAIL_EXISTS", "An account with this email already exists.");
    throw err;
  }
}

export async function registerOutsider(input: z.infer<typeof registerOutsiderSchema>) {
  const { db } = getDb();
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          accountType: "OUTSIDER_STUDENT",
          status: "PENDING_EMAIL",
          fullName: input.fullName,
          phone: input.phone ?? null,
          consentAcceptedAt: input.consentAccepted ? new Date() : null,
          consentVersion: input.consentAccepted ? CONSENT_POLICY.version : null,
          passwordUpdatedAt: new Date(),
        })
        .returning();
      if (!u) throw new ApiError("INTERNAL_ERROR", "User creation failed.");
      await tx.insert(studentProfiles).values({
        userId: u.id,
        studentKind: "OUTSIDER_STUDENT",
        institutionName: input.institutionName,
        program: input.program ?? null,
        graduationYear: input.graduationYear ?? null,
      });
      return u;
    });
    const challenge = await createAuthToken(user.id, "EMAIL_VERIFICATION", EMAIL_VERIFY_TTL_MIN);
    const verification = await dispatchChallenge(
      challenge.row,
      user.email,
      "Verify your CampusOps email",
      "/verify-email",
      challenge.token,
      challenge.otp,
      challenge.ttlSeconds,
    );
    return { user: publicUser(user), verification };
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("EMAIL_EXISTS", "An account with this email already exists.");
    throw err;
  }
}

export async function resendVerification(input: z.infer<typeof resendVerificationSchema>) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  if (!user || user.emailVerifiedAt) return { sent: true };
  const challenge = await createAuthToken(user.id, "EMAIL_VERIFICATION", EMAIL_VERIFY_TTL_MIN);
  const verification = await dispatchChallenge(
    challenge.row,
    user.email,
    "Verify your CampusOps email",
    "/verify-email",
    challenge.token,
    challenge.otp,
    challenge.ttlSeconds,
  );
  return {
    sent: true,
    verification: shouldExposeDemoOtp()
      ? verification
      : {
          challengeId: verification.challengeId,
          expiresAt: verification.expiresAt,
          delivery: verification.delivery,
          demoOtp: verification.demoOtp,
        },
  };
}

export async function verifyEmail(input: z.infer<typeof verifyEmailSchema>) {
  const { db } = getDb();
  const tokenRow =
    "token" in input
      ? await consumeByToken(input.token, ["EMAIL_VERIFICATION"])
      : await consumeByOtp(input.challengeId, input.otp, ["EMAIL_VERIFICATION"]);
  const [user] = await db.select().from(users).where(eq(users.id, tokenRow.userId)).limit(1);
  if (!user) throw new ApiError("TOKEN_INVALID", "Invalid token.");
  const nextStatus = user.accountType === "COLLEGE_STUDENT" ? "PENDING_VERIFICATION" : "ACTIVE";
  const [updated] = await db
    .update(users)
    .set({
      emailVerifiedAt: new Date(),
      status: user.status === "PENDING_EMAIL" ? nextStatus : user.status,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();
  if (!updated) throw new ApiError("INTERNAL_ERROR", "Email verification update failed.");
  return { user: publicUser(updated) };
}

export async function login(
  input: z.infer<typeof loginSchema>,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
) {
  const cfg = authConfig();
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  if (!user || !(await verifyPassword(input.password, user.passwordHash)))
    throw new ApiError("INVALID_CREDENTIALS", "Invalid email or password.");
  if (user.status === "SUSPENDED") throw new ApiError("ACCOUNT_SUSPENDED", "Account is suspended.");
  if (user.status === "REJECTED") throw new ApiError("ACCOUNT_REJECTED", "Account was rejected.");
  const refreshToken = generateOpaqueToken(48);
  const expiresAt = new Date(Date.now() + cfg.refreshTtlDays * 86_400_000);
  const [session] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      // A new sign-in starts a new family; this is what reuse detection revokes.
      familyId: randomUUID(),
      refreshTokenHash: hashToken(refreshToken, cfg.refreshPepper),
      deviceLabel: input.deviceLabel ?? null,
      ipHash: meta.ip ? hashToken(meta.ip, cfg.refreshPepper) : null,
      userAgent: meta.userAgent ?? null,
      expiresAt,
    })
    .returning();
  if (!session) throw new ApiError("INTERNAL_ERROR", "Session creation failed.");
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const accessToken = await signAccessToken(
    { sub: user.id, sid: session.id, accountType: user.accountType },
    cfg.accessSecret,
    cfg.accessTtlSeconds,
  );
  return { accessToken, refreshToken, expiresIn: cfg.accessTtlSeconds, user: publicUser(user) };
}

export async function refreshSession(
  input: z.infer<typeof refreshSchema>,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
) {
  const cfg = authConfig();
  if (!input.refreshToken) throw new ApiError("UNAUTHENTICATED", "Missing refresh token.");
  const { db } = getDb();
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, hashToken(input.refreshToken, cfg.refreshPepper)))
    .limit(1);
  if (!session) throw new ApiError("UNAUTHENTICATED", "Invalid refresh token.");
  if (session.revokedAt) {
    // Reuse means this chain was probably stolen, so the chain is what dies. The
    // user's other devices are separate families and stay signed in: revoking
    // everything turned one stale tab into a campus-wide sign-out.
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)));
    throw new ApiError("UNAUTHENTICATED", "Refresh token reuse detected.");
  }
  if (session.expiresAt.getTime() < Date.now())
    throw new ApiError("UNAUTHENTICATED", "Refresh token expired.");
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || user.status === "SUSPENDED" || user.status === "REJECTED")
    throw new ApiError("UNAUTHENTICATED", "Account cannot refresh.");
  const newRefreshToken = generateOpaqueToken(48);
  const [newSession] = await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)))
      .returning();
    if (!revoked) throw new ApiError("UNAUTHENTICATED", "Refresh token reuse detected.");
    const [s] = await tx
      .insert(sessions)
      .values({
        userId: user.id,
        familyId: session.familyId,
        refreshTokenHash: hashToken(newRefreshToken, cfg.refreshPepper),
        deviceLabel: session.deviceLabel,
        ipHash: meta.ip ? hashToken(meta.ip, cfg.refreshPepper) : session.ipHash,
        userAgent: meta.userAgent ?? session.userAgent,
        expiresAt: new Date(Date.now() + cfg.refreshTtlDays * 86_400_000),
      })
      .returning();
    return [s];
  });
  if (!newSession) throw new ApiError("INTERNAL_ERROR", "Session rotation failed.");
  const accessToken = await signAccessToken(
    { sub: user.id, sid: newSession.id, accountType: user.accountType },
    cfg.accessSecret,
    cfg.accessTtlSeconds,
  );
  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn: cfg.accessTtlSeconds,
    user: publicUser(user),
  };
}

export async function logout(sessionId: string) {
  const { db } = getDb();
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function logoutAll(userId: string) {
  const { db } = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function forgotPassword(input: z.infer<typeof forgotPasswordSchema>) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  if (!user) return { sent: true };
  const purpose: Purpose =
    user.accountType === "STAFF" && user.status === "PENDING_EMAIL"
      ? "STAFF_SETUP"
      : "PASSWORD_RESET";
  const challenge = await createAuthToken(user.id, purpose, RESET_TTL_MIN);
  const verification = await dispatchChallenge(
    challenge.row,
    user.email,
    "Reset your CampusOps password",
    "/reset-password",
    challenge.token,
    challenge.otp,
    challenge.ttlSeconds,
  );
  return { sent: true, ...(shouldExposeDemoOtp() ? { verification } : {}) };
}

export async function resetPassword(input: z.infer<typeof resetPasswordSchema>) {
  const url = runtimeDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL or DATABASE_URL_POOLED is not configured.");

  // Password reset is low volume. Give this security-sensitive flow a fresh
  // DB pool rather than reusing an idle connection that a hosted pooler may
  // have reset while the user was reading their email.
  const client = createDb(url, 1);
  try {
    const { db } = client;
    const tokenRow =
      "token" in input
        ? await consumeByToken(input.token, ["PASSWORD_RESET", "STAFF_SETUP"], db)
        : await consumeByOtp(
            "",
            input.otp,
            ["PASSWORD_RESET", "STAFF_SETUP"],
            input.email,
            db,
            client.sql,
          );
    const passwordHash = await hashPassword(input.newPassword);
    const [user] = await db.select().from(users).where(eq(users.id, tokenRow.userId)).limit(1);
    if (!user) throw new ApiError("TOKEN_INVALID", "Invalid token.");
    const isStaffSetup = tokenRow.purpose === "STAFF_SETUP";
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash,
          passwordUpdatedAt: new Date(),
          updatedAt: new Date(),
          ...(isStaffSetup ? { status: "ACTIVE" as const, emailVerifiedAt: new Date() } : {}),
        })
        .where(eq(users.id, user.id));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
    });
    return { reset: true };
  } finally {
    await closeDb(client);
  }
}

export async function changePassword(userId: string, input: z.infer<typeof changePasswordSchema>) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash)))
    throw new ApiError("INVALID_CREDENTIALS", "Current password is incorrect.");
  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, passwordUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  });
  return { changed: true, reloginRequired: true };
}

export function publicUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    accountType: user.accountType,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    phone: user.phone,
    phoneVerifiedAt: user.phoneVerifiedAt,
    createdAt: user.createdAt,
  };
}

export async function updateMe(
  userId: string,
  input: { fullName?: string | undefined; phone?: string | null | undefined },
) {
  const { db } = getDb();
  const [current] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!current) throw new ApiError("NOT_FOUND", "User not found.");
  const nextPhone = input.phone === undefined ? current.phone : input.phone;
  const phoneChanged = nextPhone !== current.phone;
  const [updated] = await db
    .update(users)
    .set({
      ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      ...(phoneChanged ? { phoneVerifiedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) throw new ApiError("INTERNAL_ERROR", "Profile update failed.");
  return getMe(updated.id);
}

export async function getMe(userId: string) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError("NOT_FOUND", "User not found.");
  const [student] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, userId))
    .limit(1);
  const roles = await db
    .select({
      id: roleAssignments.id,
      role: roleAssignments.role,
      scopeType: roleAssignments.scopeType,
      departmentId: roleAssignments.departmentId,
    })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.isActive, true)));
  const memberships = await db
    .select({
      clubId: clubMemberships.clubId,
      clubRole: clubMemberships.clubRole,
      isActive: clubMemberships.isActive,
      clubName: clubs.name,
    })
    .from(clubMemberships)
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .where(and(eq(clubMemberships.userId, userId), eq(clubMemberships.isActive, true)));
  return {
    user: publicUser(user),
    studentProfile: student ?? null,
    globalRoles: roles,
    clubMemberships: memberships,
  };
}

/**
 * Everything the institution holds about one person, in one JSON document.
 *
 * A consent record with no export or deletion path is decoration. This is the
 * export half: it reads only rows the caller already owns or is named in, so it
 * is safe to hand back to the account itself.
 */
export async function exportMyData(userId: string) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError("NOT_FOUND", "User not found.");
  const [profile] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, userId))
    .limit(1);
  const roles = await db
    .select({
      role: roleAssignments.role,
      scopeType: roleAssignments.scopeType,
      departmentId: roleAssignments.departmentId,
      grantedAt: roleAssignments.createdAt,
    })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const memberships = await db
    .select({
      clubId: clubMemberships.clubId,
      clubRole: clubMemberships.clubRole,
      isActive: clubMemberships.isActive,
    })
    .from(clubMemberships)
    .where(eq(clubMemberships.userId, userId));
  const myRegistrations = await db
    .select({
      id: registrations.id,
      eventId: registrations.eventId,
      status: registrations.status,
      appliedAt: registrations.appliedAt,
    })
    .from(registrations)
    .where(eq(registrations.userId, userId));
  const myPasses = await db
    .select({
      publicId: passes.publicId,
      registrationId: passes.registrationId,
      revokedAt: passes.revokedAt,
      createdAt: passes.createdAt,
    })
    .from(passes)
    .innerJoin(registrations, eq(registrations.id, passes.registrationId))
    .where(eq(registrations.userId, userId));
  const myComplaints = await db
    .select({
      id: complaints.id,
      eventId: complaints.eventId,
      status: complaints.status,
      createdAt: complaints.createdAt,
    })
    .from(complaints)
    .where(eq(complaints.reportedBy, userId));

  return {
    exportedAt: new Date().toISOString(),
    account: publicUser(user),
    // Consent is part of the record, including the fact that older rows have no
    // policy version rather than a version we invented for them.
    consent: {
      acceptedAt: user.consentAcceptedAt,
      policyVersion: user.consentVersion,
      currentPolicyVersion: CONSENT_POLICY.version,
      policySummary: CONSENT_POLICY.summary,
    },
    studentProfile: profile ?? null,
    roles,
    clubMemberships: memberships,
    registrations: myRegistrations,
    passes: myPasses,
    complaintsReportedByMe: myComplaints,
  };
}

/**
 * Erase the person, keep the institution's record.
 *
 * A hard delete cascades through registrations, passes and complaints, which are
 * not only the user's data: attendance counts, reports and complaint histories
 * belong to events and to other people. Deleting the account therefore
 * anonymises it in place — identifiers are overwritten, sessions and tokens are
 * destroyed, the row stays as a tombstone so nothing dangles.
 */
export async function deleteMyAccount(userId: string, confirmation: string) {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError("NOT_FOUND", "User not found.");
  if (user.anonymisedAt) throw new ApiError("CONFLICT", "This account was already deleted.");
  if (confirmation.trim().toLowerCase() !== user.email.toLowerCase())
    throw new ApiError("VALIDATION_ERROR", "Type your account email exactly to confirm deletion.");
  const [holdsInstitution] = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.role, "ADMIN")))
    .limit(1);
  if (holdsInstitution)
    throw new ApiError(
      "LAST_ADMIN",
      "An administrator cannot delete their own account here. Ask another administrator to remove your role first.",
    );

  const placeholders = {
    fullName: "Deleted account",
    email: `deleted+${userId}@invalid.campusops`,
    phone: null,
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
  };
  await db.transaction(async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, userId));
    await tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(eq(authTokens.userId, userId));
    await tx
      .update(studentProfiles)
      .set({
        institutionName: "Deleted account",
        rollNumber: null,
        collegeIdNumber: null,
        program: null,
        photoFileId: null,
        idProofFileId: null,
        updatedAt: new Date(),
      })
      .where(eq(studentProfiles.userId, userId));
    await tx.delete(clubMemberships).where(eq(clubMemberships.userId, userId));
    await tx.delete(roleAssignments).where(eq(roleAssignments.userId, userId));
    // Complaints keep their reporter link: the issue is still a live operational
    // record for the event, and the person behind it is already anonymous.
    await tx
      .update(users)
      .set({
        ...placeholders,
        // A password nobody holds. Authentication for this row is impossible
        // even if a future code path forgets to check anonymisedAt.
        passwordHash: `deleted:${randomUUID()}`,
        status: "REJECTED",
        consentAcceptedAt: null,
        consentVersion: null,
        anonymisedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  });
  return { deleted: true };
}
