import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "../../config/env";
import { authenticate } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson } from "../../middleware/validate";
import { ApiError } from "../../utils/api-error";
import { ok } from "../../utils/response";
import { writeAudit } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

const REFRESH_COOKIE = "campusops_refresh";

function clientMeta(c: Context) {
  return {
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip"),
    userAgent: c.req.header("user-agent"),
  };
}

function setRefreshCookie(c: Context, token: string) {
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.NODE_ENV === "production",
    path: "/api/v1/auth",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400,
  });
}

export const authRoutes = new Hono();

// Public reference data needed by the student registration form. No staff or
// student records are exposed here.
authRoutes.get("/departments", async (c) => {
  const { listDepartments } = await import("../departments/service");
  return ok(c, await listDepartments());
});
authRoutes.get("/programs", async (c) => {
  const { listPrograms } = await import("../departments/service");
  return ok(c, await listPrograms());
});

authRoutes.post(
  "/register/college",
  rateLimit({ windowMs: 60_000, max: 10, prefix: "register-college" }),
  async (c) => {
    const input = await parseJson(c, schemas.registerCollegeSchema);
    const result = await service.registerCollege(input);
    await writeAudit(c, {
      action: "AUTH_REGISTER_COLLEGE",
      entityType: "user",
      entityId: result.user.id,
      after: { email: result.user.email, status: result.user.status },
    });
    return ok(c, result, 201);
  },
);

authRoutes.post(
  "/register/outsider",
  rateLimit({ windowMs: 60_000, max: 10, prefix: "register-outsider" }),
  async (c) => {
    const input = await parseJson(c, schemas.registerOutsiderSchema);
    const result = await service.registerOutsider(input);
    await writeAudit(c, {
      action: "AUTH_REGISTER_OUTSIDER",
      entityType: "user",
      entityId: result.user.id,
      after: { email: result.user.email, status: result.user.status },
    });
    return ok(c, result, 201);
  },
);

authRoutes.post("/verify-email", async (c) => {
  const input = await parseJson(c, schemas.verifyEmailSchema);
  const result = await service.verifyEmail(input);
  await writeAudit(c, {
    action: "AUTH_EMAIL_VERIFIED",
    entityType: "user",
    entityId: result.user.id,
    after: { status: result.user.status },
  });
  return ok(c, result);
});

authRoutes.post(
  "/resend-verification",
  rateLimit({ windowMs: 60_000, max: 3, prefix: "resend-verification" }),
  async (c) => {
    const input = await parseJson(c, schemas.resendVerificationSchema);
    return ok(c, await service.resendVerification(input));
  },
);

authRoutes.post("/login", rateLimit({ windowMs: 60_000, max: 20, prefix: "login" }), async (c) => {
  const input = await parseJson(c, schemas.loginSchema);
  const result = await service.login(input, clientMeta(c));
  if (input.client === "web") setRefreshCookie(c, result.refreshToken);
  await writeAudit(c, { action: "AUTH_LOGIN", entityType: "user", entityId: result.user.id });
  return ok(c, {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    user: result.user,
    ...(input.client === "mobile" ? { refreshToken: result.refreshToken } : {}),
  });
});

authRoutes.post("/refresh", async (c) => {
  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    body = null;
  }
  const parsed = schemas.refreshSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Request validation failed.");
  }
  const input = parsed.data;
  const cookieToken = getCookie(c, REFRESH_COOKIE);
  const result = await service.refreshSession(
    { ...input, refreshToken: input.refreshToken ?? cookieToken },
    clientMeta(c),
  );
  if (input.client === "web") setRefreshCookie(c, result.refreshToken);
  return ok(c, {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    user: result.user,
    ...(input.client === "mobile" ? { refreshToken: result.refreshToken } : {}),
  });
});

authRoutes.post("/logout", authenticate, async (c) => {
  const auth = c.get("auth");
  await service.logout(auth.sessionId);
  deleteCookie(c, REFRESH_COOKIE, { path: "/api/v1/auth" });
  await writeAudit(c, { action: "AUTH_LOGOUT", entityType: "session", entityId: auth.sessionId });
  return ok(c, { loggedOut: true });
});

authRoutes.post("/logout-all", authenticate, async (c) => {
  const auth = c.get("auth");
  await service.logoutAll(auth.user.id);
  deleteCookie(c, REFRESH_COOKIE, { path: "/api/v1/auth" });
  await writeAudit(c, { action: "AUTH_LOGOUT_ALL", entityType: "user", entityId: auth.user.id });
  return ok(c, { loggedOutAll: true });
});

authRoutes.post(
  "/forgot-password",
  rateLimit({ windowMs: 60_000, max: 5, prefix: "forgot" }),
  async (c) => {
    const input = await parseJson(c, schemas.forgotPasswordSchema);
    const result = await service.forgotPassword(input);
    return ok(c, result);
  },
);

authRoutes.post("/reset-password", async (c) => {
  const input = await parseJson(c, schemas.resetPasswordSchema);
  const result = await service.resetPassword(input);
  await writeAudit(c, { action: "AUTH_PASSWORD_RESET", entityType: "user" });
  return ok(c, result);
});

authRoutes.post("/change-password", authenticate, async (c) => {
  const input = await parseJson(c, schemas.changePasswordSchema);
  const auth = c.get("auth");
  const result = await service.changePassword(auth.user.id, input);
  deleteCookie(c, REFRESH_COOKIE, { path: "/api/v1/auth" });
  await writeAudit(c, {
    action: "AUTH_PASSWORD_CHANGED",
    entityType: "user",
    entityId: auth.user.id,
  });
  return ok(c, result);
});

export const meRoutes = new Hono();
meRoutes.use("*", authenticate);
meRoutes.get("/", async (c) => ok(c, await service.getMe(c.get("auth").user.id)));

meRoutes.patch("/", async (c) => {
  const input = await parseJson(c, schemas.updateMeSchema);
  return ok(c, await service.updateMe(c.get("auth").user.id, input));
});
