import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import { events, type clubs } from "../db/schema";
import { ApiError } from "../utils/api-error";
import { type AuthContext, canAccessDepartment, hasRole } from "./auth";

/**
 * Event scope is always resolved from the event row, never from a client-supplied
 * clubId. Coordinators act only inside clubs where they hold an active membership.
 */

export type EventRow = typeof events.$inferSelect;

/** May create and run the club's events. Club faculty are not coordinators. */
export function isClubCoordinator(auth: AuthContext, clubId: string): boolean {
  return auth.memberships.some(
    (m) => m.clubId === clubId && (m.clubRole === "LEAD" || m.clubRole === "COORDINATOR"),
  );
}

/**
 * Anyone organising the event: its club's coordinators and its club faculty.
 * This is who may scan access QRs — there is no separate scanning-staff role.
 */
export function isClubOrganiser(auth: AuthContext, clubId: string): boolean {
  return auth.memberships.some((m) => m.clubId === clubId);
}

/** Faculty attached to the club. They approve its events and read its reports. */
export function isClubFaculty(auth: AuthContext, clubId: string): boolean {
  return auth.memberships.some((m) => m.clubId === clubId && m.clubRole === "FACULTY");
}

export function isClubLead(auth: AuthContext, clubId: string): boolean {
  return auth.memberships.some((m) => m.clubId === clubId && m.clubRole === "LEAD");
}

/** Institution oversight: admin always; HOD/Dean within department scope. */
export function hasEventOversight(
  auth: Pick<AuthContext, "roles">,
  clubDepartmentId: string | null,
): boolean {
  if (hasRole(auth, "ADMIN")) return true;
  return hasRole(auth, "HOD_DEAN") && canAccessDepartment(auth, "HOD_DEAN", clubDepartmentId);
}

export async function loadEventWithClub(eventId: string) {
  const { db } = getDb();
  const [row] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Event not found.");
  return row;
}

/** Coordinator-level management rights over the event's club. */
export function requireEventManage(param = "id") {
  return createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    if (auth.user.status !== "ACTIVE")
      throw new ApiError("ACCOUNT_PENDING", "Account is not active yet.");
    const eventId = c.req.param(param);
    if (!eventId) throw new ApiError("VALIDATION_ERROR", "Missing event id.");
    const event = await loadEventWithClub(eventId);
    // Oversight (Admin, HOD/Dean) may read the event and decide approvals, but
    // every change belongs to the club's own coordinators.
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    c.set("event", event);
    await next();
  });
}

/** Read access for club members, approvers and institution oversight. */
/**
 * Read access to an event's operational records: who scanned in, and what
 * participants reported.
 *
 * Deliberately stricter than `requireEventOperationalRead`, which lets any
 * faculty account read event detail for approval purposes. Complaints and scan
 * logs contain participant information and must stay with the people running
 * THIS event: its club's coordinators and club faculty, plus departmental
 * oversight (HOD/Dean) and Admin. Everyone else gets 404, so the event's private
 * records are not even discoverable.
 */
export function requireEventOrganiserRead(param = "id") {
  return createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    const eventId = c.req.param(param);
    if (!eventId) throw new ApiError("VALIDATION_ERROR", "Missing event id.");
    const event = await loadEventWithClub(eventId);
    const { db } = getDb();
    const { clubs } = await import("../db/schema");
    const [club] = await db.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);
    if (
      !isClubOrganiser(auth, event.clubId) &&
      !hasEventOversight(auth, club?.departmentId ?? null)
    ) {
      throw new ApiError("NOT_FOUND", "Event not found.");
    }
    c.set("event", event);
    c.set("eventClub", club as typeof clubs.$inferSelect);
    await next();
  });
}

export function requireEventOperationalRead(param = "id") {
  return createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    const eventId = c.req.param(param);
    if (!eventId) throw new ApiError("VALIDATION_ERROR", "Missing event id.");
    const event = await loadEventWithClub(eventId);
    const { db } = getDb();
    const { clubs } = await import("../db/schema");
    const [club] = await db.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);
    const isOrganiser = isClubOrganiser(auth, event.clubId);
    const oversight = hasEventOversight(auth, club?.departmentId ?? null);
    const isFaculty = hasRole(auth, "FACULTY");
    if (!isOrganiser && !oversight && !isFaculty) {
      throw new ApiError("NOT_FOUND", "Event not found.");
    }
    c.set("event", event);
    c.set("eventClub", club as typeof clubs.$inferSelect);
    await next();
  });
}

/**
 * Plain assertions for routes that address a child resource (a quiz, a QR, a
 * complaint) and must resolve the parent event themselves. The middleware guards
 * above and these functions share one definition of each right.
 */
export async function assertEventManage(auth: AuthContext, eventId: string) {
  if (auth.user.status !== "ACTIVE")
    throw new ApiError("ACCOUNT_PENDING", "Account is not active yet.");
  const event = await loadEventWithClub(eventId);
  if (!isClubCoordinator(auth, event.clubId))
    throw new ApiError(
      "FORBIDDEN",
      "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
    );
  return event;
}

export async function assertEventOrganiserRead(auth: AuthContext, eventId: string) {
  const event = await loadEventWithClub(eventId);
  const { db } = getDb();
  const { clubs } = await import("../db/schema");
  const [club] = await db.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);
  if (!isClubOrganiser(auth, event.clubId) && !hasEventOversight(auth, club?.departmentId ?? null))
    throw new ApiError("NOT_FOUND", "Event not found.");
  return { event, club: club ?? null };
}

declare module "hono" {
  interface ContextVariableMap {
    event: EventRow;
    eventClub: typeof clubs.$inferSelect;
  }
}
