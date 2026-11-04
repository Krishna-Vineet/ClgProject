import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import { clubs } from "../db/schema";
import { ApiError } from "../utils/api-error";
import { canAccessDepartment, hasRole } from "./auth";

/** HOD/Dean within their department scope. */
export function departmentOwner(
  auth: Parameters<typeof hasRole>[0],
  departmentId: string | null,
): boolean {
  return hasRole(auth, "HOD_DEAN") && canAccessDepartment(auth, "HOD_DEAN", departmentId);
}

export function requireClubRead(param = "id") {
  return createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    const clubId = c.req.param(param);
    if (!clubId) throw new ApiError("VALIDATION_ERROR", "Missing club id.");
    const { db } = getDb();
    const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
    if (!club) throw new ApiError("NOT_FOUND", "Club not found.");
    const isMember = auth.memberships.some((m) => m.clubId === clubId);
    const seniorRead =
      hasRole(auth, "HOD_DEAN") && canAccessDepartment(auth, "HOD_DEAN", club.departmentId);
    const allowed = isMember || hasRole(auth, "ADMIN") || seniorRead;
    if (!allowed) throw new ApiError("FORBIDDEN", "You do not have access to this club.");
    c.set("club", club);
    await next();
  });
}

export function requireClubManage(param = "id") {
  return createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    const clubId = c.req.param(param);
    if (!clubId) throw new ApiError("VALIDATION_ERROR", "Missing club id.");
    const { db } = getDb();
    const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
    if (!club) throw new ApiError("NOT_FOUND", "Club not found.");
    const isLead = auth.memberships.some(
      (m) => m.clubId === clubId && m.clubRole === "LEAD" && m.isActive,
    );
    // HOD/Dean owns the club structurally; the lead runs it day to day.
    // Whether the lead may touch *faculty* memberships is decided per action in
    // the service, because only HOD/Dean and Admin may add or remove faculty.
    const allowed = isLead || hasRole(auth, "ADMIN") || departmentOwner(auth, club.departmentId);
    if (!allowed) throw new ApiError("FORBIDDEN", "You cannot manage this club.");
    c.set("club", club);
    await next();
  });
}

declare module "hono" {
  interface ContextVariableMap {
    club: typeof clubs.$inferSelect;
  }
}
