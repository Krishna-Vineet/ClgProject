import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { authConfig } from "../config/env";
import { getDb } from "../db/client";
import { clubMemberships, roleAssignments, sessions, users } from "../db/schema";
import { ApiError } from "../utils/api-error";
import { verifyAccessToken } from "../utils/jwt";

export type AuthUser = typeof users.$inferSelect;
export type RoleAssignment = typeof roleAssignments.$inferSelect;
export type ClubMembership = typeof clubMemberships.$inferSelect;
export type AuthContext = {
  user: AuthUser;
  sessionId: string;
  roles: RoleAssignment[];
  memberships: ClubMembership[];
};

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export const authenticate = createMiddleware(async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer "))
    throw new ApiError("UNAUTHENTICATED", "Missing bearer token.");
  const cfg = authConfig();
  let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    payload = await verifyAccessToken(header.slice(7), cfg.accessSecret);
  } catch {
    throw new ApiError("UNAUTHENTICATED", "Invalid or expired access token.");
  }
  const { db } = getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, payload.sid)).limit(1);
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() < Date.now() ||
    session.userId !== payload.sub
  ) {
    throw new ApiError("UNAUTHENTICATED", "Session is no longer valid.");
  }
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user) throw new ApiError("UNAUTHENTICATED", "User not found.");
  if (user.status === "SUSPENDED") throw new ApiError("ACCOUNT_SUSPENDED", "Account is suspended.");
  if (user.status === "REJECTED") throw new ApiError("ACCOUNT_REJECTED", "Account was rejected.");
  const roles = await db
    .select()
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, user.id), eq(roleAssignments.isActive, true)));
  const memberships = await db
    .select()
    .from(clubMemberships)
    .where(and(eq(clubMemberships.userId, user.id), eq(clubMemberships.isActive, true)));
  c.set("auth", { user, sessionId: session.id, roles, memberships });
  await next();
});

export const requireActiveAccount = createMiddleware(async (c, next) => {
  const auth = c.get("auth");
  if (!auth) throw new ApiError("UNAUTHENTICATED", "Authentication required.");
  if (auth.user.status !== "ACTIVE")
    throw new ApiError("ACCOUNT_PENDING", "Account is not active yet.");
  await next();
});

export function requireRole(...allowed: Array<RoleAssignment["role"]>) {
  return createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    if (!auth.roles.some((r) => allowed.includes(r.role))) {
      throw new ApiError("FORBIDDEN", "Insufficient role.");
    }
    await next();
  });
}

export function hasRole(auth: Pick<AuthContext, "roles">, role: RoleAssignment["role"]): boolean {
  return auth.roles.some((r) => r.role === role);
}

export function departmentScope(
  auth: Pick<AuthContext, "roles">,
  role: RoleAssignment["role"],
): { global: boolean; departmentIds: string[] } {
  const rows = auth.roles.filter((r) => r.role === role);
  return {
    global: rows.some((r) => r.scopeType === "GLOBAL"),
    departmentIds: rows.map((r) => r.departmentId).filter((x): x is string => Boolean(x)),
  };
}

export function canAccessDepartment(
  auth: Pick<AuthContext, "roles">,
  role: RoleAssignment["role"],
  departmentId: string | null,
): boolean {
  const scope = departmentScope(auth, role);
  if (scope.global) return true;
  if (!departmentId) return false;
  return scope.departmentIds.includes(departmentId);
}
