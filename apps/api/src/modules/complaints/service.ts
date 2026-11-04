import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { env } from "../../config/env";
import { getDb } from "../../db/client";
import {
  events,
  clubMemberships,
  clubs,
  complaintLocations,
  complaintUpdates,
  complaints,
  registrations,
  roleAssignments,
  users,
} from "../../db/schema";
import { type AuthContext, hasRole } from "../../middleware/auth";
import {
  hasEventOversight,
  isClubCoordinator,
  isClubOrganiser,
} from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { renderComplaintPoster } from "./poster";
import type {
  complaintListQuerySchema,
  createLocationSchema,
  raiseComplaintSchema,
  updateComplaintSchema,
  updateLocationSchema,
} from "./schemas";

async function loadEventWithClub(eventId: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ event: events, club: clubs })
    .from(events)
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Event not found.");
  return row;
}

export async function loadLocation(locationId: string) {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(complaintLocations)
    .where(eq(complaintLocations.id, locationId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Location not found.");
  return row;
}

/** Route-level guards: a location is managed by its event's coordinators. */
export async function assertEventManage(auth: AuthContext, eventId: string) {
  const { event } = await loadEventWithClub(eventId);
  if (hasRole(auth, "ADMIN") || isClubCoordinator(auth, event.clubId)) return;
  throw new ApiError("FORBIDDEN", "You cannot manage this event.");
}

export async function assertEventRead(auth: AuthContext, eventId: string) {
  const { event, club } = await loadEventWithClub(eventId);
  if (isClubOrganiser(auth, event.clubId) || hasEventOversight(auth, club.departmentId)) return;
  throw new ApiError("NOT_FOUND", "Location not found.");
}

/** Complaints route only to the event's own organisers, never institution-wide. */
function assertHandles(auth: AuthContext, clubId: string, departmentId: string | null) {
  if (isClubOrganiser(auth, clubId) || hasEventOversight(auth, departmentId)) return;
  throw new ApiError("NOT_FOUND", "Complaint not found.");
}

/**
 * Reporting points with their live counts. The outer column is qualified
 * explicitly: an interpolated column inside a select field renders unqualified,
 * which a correlated subquery would resolve against its own table.
 */
export async function listLocations(eventId: string) {
  const { db } = getDb();
  const rows = await db
    .select({
      location: complaintLocations,
      open: sql<number>`(SELECT count(*)::int FROM complaints c WHERE c.location_id = "complaint_locations"."id" AND c.status <> 'CLOSED' AND c.status <> 'RESOLVED')`,
      total: sql<number>`(SELECT count(*)::int FROM complaints c WHERE c.location_id = "complaint_locations"."id")`,
    })
    .from(complaintLocations)
    .where(eq(complaintLocations.eventId, eventId))
    .orderBy(desc(complaintLocations.createdAt));
  return rows.map((r) => ({ ...r.location, open: r.open, total: r.total }));
}

export async function createLocation(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof createLocationSchema>,
  audit?: AuditContext,
) {
  await loadEventWithClub(eventId);
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(complaintLocations)
        .values({
          eventId,
          label: input.label,
          description: input.description ?? null,
          createdBy: auth.user.id,
        })
        .returning();
      if (!row) throw new ApiError("INTERNAL_ERROR", "Location creation failed.");
      if (audit)
        await insertAudit(tx, audit, {
          action: "COMPLAINT_LOCATION_CREATED",
          entityType: "complaint_location",
          entityId: row.id,
          eventId,
          after: { label: row.label },
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "This event already has a location with that label.");
    throw err;
  }
}

export async function updateLocation(
  locationId: string,
  input: z.infer<typeof updateLocationSchema>,
  audit?: AuditContext,
) {
  const before = await loadLocation(locationId);
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(complaintLocations)
        .set({
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.revoked === undefined ? {} : { revokedAt: input.revoked ? new Date() : null }),
        })
        .where(eq(complaintLocations.id, locationId))
        .returning();
      if (audit)
        await insertAudit(tx, audit, {
          action: "COMPLAINT_LOCATION_UPDATED",
          entityType: "complaint_location",
          entityId: locationId,
          eventId: before.eventId,
          before: { label: before.label, revokedAt: before.revokedAt },
          after: input,
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "This event already has a location with that label.");
    throw err;
  }
}

/** Confirmed participants and this event's own organisers may report. */
async function assertMayReport(auth: AuthContext, event: typeof events.$inferSelect) {
  if (hasRole(auth, "ADMIN") || isClubOrganiser(auth, event.clubId)) return;
  const { db } = getDb();
  const [registration] = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, event.id),
        eq(registrations.userId, auth.user.id),
        eq(registrations.status, "CONFIRMED"),
      ),
    )
    .limit(1);
  if (!registration)
    throw new ApiError(
      "FORBIDDEN",
      "You need a confirmed registration for this event to report an issue here.",
    );
}

/** What the app shows immediately after scanning a complaint QR. */
export async function resolveLocation(auth: AuthContext, locationId: string) {
  const location = await loadLocation(locationId);
  if (location.revokedAt)
    throw new ApiError("CONFLICT", "This reporting point is closed. Find a coordinator instead.");
  const { event, club } = await loadEventWithClub(location.eventId);
  await assertMayReport(auth, event);
  return {
    location: {
      id: location.id,
      label: location.label,
      description: location.description,
    },
    event: { id: event.id, title: event.title, status: event.status },
    club: { id: club.id, name: club.name },
  };
}

export async function poster(locationId: string): Promise<Uint8Array> {
  const location = await loadLocation(locationId);
  const { event, club } = await loadEventWithClub(location.eventId);
  const payload = `${env.COMPLAINT_QR_BASE.replace(/\/$/, "")}/${location.id}`;
  return renderComplaintPoster({
    qrPayload: payload,
    clubName: club.name,
    eventTitle: event.title,
    eventWhen: new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: env.CAMPUS_TIMEZONE,
    }).format(event.startsAt),
    locationLabel: location.label,
    locationDescription: location.description,
    reference: location.id.slice(0, 8).toUpperCase(),
  });
}

/** Raised by a participant from the app after scanning the location's QR. */
export async function raise(
  auth: AuthContext,
  locationId: string,
  input: z.infer<typeof raiseComplaintSchema>,
) {
  const location = await loadLocation(locationId);
  if (location.revokedAt) throw new ApiError("CONFLICT", "This reporting point is closed.");
  const { event } = await loadEventWithClub(location.eventId);
  if (event.status === "CANCELLED" || event.status === "COMPLETED")
    throw new ApiError("INVALID_STATE_TRANSITION", "This event is closed.");
  await assertMayReport(auth, event);
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(complaints)
      .values({
        eventId: location.eventId,
        locationId,
        reportedBy: auth.user.id,
        category: input.category,
        description: input.description,
      })
      .returning();
    if (!row) throw new ApiError("INTERNAL_ERROR", "Could not record the complaint.");
    await tx.insert(complaintUpdates).values({
      complaintId: row.id,
      actorId: auth.user.id,
      fromStatus: null,
      toStatus: "OPEN",
      note: "Reported from the location QR.",
    });
    return row;
  });
}

/** The reporter's own issues, so the phone can show progress after submitting. */
export async function mine(auth: AuthContext, limit = 25, offset = 0) {
  const { db } = getDb();
  const rows = await db
    .select({
      complaint: complaints,
      eventTitle: events.title,
      locationLabel: complaintLocations.label,
    })
    .from(complaints)
    .innerJoin(events, eq(events.id, complaints.eventId))
    .innerJoin(complaintLocations, eq(complaintLocations.id, complaints.locationId))
    .where(eq(complaints.reportedBy, auth.user.id))
    .orderBy(desc(complaints.createdAt), desc(complaints.id))
    .limit(limit + 1)
    .offset(offset);
  return {
    items: rows
      .slice(0, limit)
      .map((r) => ({ ...r.complaint, eventTitle: r.eventTitle, locationLabel: r.locationLabel })),
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}

export async function list(eventId: string, page: z.infer<typeof complaintListQuerySchema>) {
  const { db } = getDb();
  const filters = [eq(complaints.eventId, eventId)];
  if (page.status) filters.push(eq(complaints.status, page.status));
  if (page.locationId) filters.push(eq(complaints.locationId, page.locationId));
  const rows = await db
    .select({
      complaint: complaints,
      reporter: { id: users.id, fullName: users.fullName, email: users.email },
      locationLabel: complaintLocations.label,
    })
    .from(complaints)
    .innerJoin(users, eq(users.id, complaints.reportedBy))
    .leftJoin(complaintLocations, eq(complaintLocations.id, complaints.locationId))
    .where(and(...filters))
    .orderBy(desc(complaints.createdAt), desc(complaints.id))
    .limit(page.limit + 1)
    .offset(page.offset);
  return {
    items: rows.slice(0, page.limit).map((r) => ({
      ...r.complaint,
      reporter: r.reporter,
      locationLabel: r.locationLabel,
    })),
    limit: page.limit,
    offset: page.offset,
    hasMore: rows.length > page.limit,
  };
}

export async function detail(auth: AuthContext, complaintId: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ complaint: complaints, clubId: events.clubId, departmentId: clubs.departmentId })
    .from(complaints)
    .innerJoin(events, eq(events.id, complaints.eventId))
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .where(eq(complaints.id, complaintId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Complaint not found.");
  // The reporter may follow their own report; organisers may act on it.
  if (row.complaint.reportedBy !== auth.user.id) assertHandles(auth, row.clubId, row.departmentId);
  const updates = await db
    .select({
      update: complaintUpdates,
      actor: { id: users.id, fullName: users.fullName },
    })
    .from(complaintUpdates)
    .innerJoin(users, eq(users.id, complaintUpdates.actorId))
    .where(eq(complaintUpdates.complaintId, complaintId))
    .orderBy(desc(complaintUpdates.createdAt));
  return { complaint: row.complaint, updates };
}

export async function update(
  auth: AuthContext,
  complaintId: string,
  input: z.infer<typeof updateComplaintSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [row] = await db
    .select({ complaint: complaints, clubId: events.clubId, departmentId: clubs.departmentId })
    .from(complaints)
    .innerJoin(events, eq(events.id, complaints.eventId))
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .where(eq(complaints.id, complaintId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Complaint not found.");
  assertHandles(auth, row.clubId, row.departmentId);

  if (input.assignedTo) {
    // Assigning work to someone who cannot open the complaint would silently
    // strand it, so the assignee must be able to act on this event too.
    const [assignee] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, input.assignedTo))
      .limit(1);
    if (!assignee) throw new ApiError("NOT_FOUND", "Assignee not found.");
    if (assignee.status !== "ACTIVE") throw new ApiError("CONFLICT", "That account is not active.");
    const memberships = await db
      .select({ clubId: clubMemberships.clubId })
      .from(clubMemberships)
      .where(
        and(
          eq(clubMemberships.userId, input.assignedTo),
          eq(clubMemberships.clubId, row.clubId),
          eq(clubMemberships.isActive, true),
        ),
      );
    const roles = await db
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.userId, input.assignedTo), eq(roleAssignments.isActive, true)));
    const mayAct = memberships.length > 0 || hasEventOversight({ roles }, row.departmentId);
    if (!mayAct)
      throw new ApiError(
        "VALIDATION_ERROR",
        "That person is not one of this event's organisers, so they cannot be assigned its issues.",
      );
  }

  const closing = input.status === "RESOLVED" || input.status === "CLOSED";
  return db.transaction(async (tx) => {
    const [updatedRow] = await tx
      .update(complaints)
      .set({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.assignedTo === undefined ? {} : { assignedTo: input.assignedTo }),
        ...(closing ? { resolvedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(complaints.id, complaintId))
      .returning();
    await tx.insert(complaintUpdates).values({
      complaintId,
      actorId: auth.user.id,
      fromStatus: row.complaint.status,
      toStatus: input.status ?? row.complaint.status,
      assignedTo: input.assignedTo ?? null,
      note: input.note ?? null,
    });
    if (audit)
      await insertAudit(tx, audit, {
        action: "COMPLAINT_UPDATED",
        entityType: "complaint",
        entityId: complaintId,
        eventId: row.complaint.eventId,
        before: { status: row.complaint.status },
        after: input,
      });
    return updatedRow;
  });
}

/** Live counters for the event workspace. */
export async function summary(eventId: string) {
  const { db } = getDb();
  const rows = await db
    .select({ status: complaints.status, n: sql<number>`count(*)::int` })
    .from(complaints)
    .where(eq(complaints.eventId, eventId))
    .groupBy(complaints.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const [locations] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(complaintLocations)
    .where(and(eq(complaintLocations.eventId, eventId), isNull(complaintLocations.revokedAt)));
  return { byStatus, activeLocations: locations?.n ?? 0 };
}
