import { randomUUID } from "node:crypto";
import { ACTIVE_RESERVATION_STATUSES, mergeRanges, rangesOverlap } from "@campusops/shared";
import { type SQL, and, count, eq, gt, ilike, inArray, lt, or } from "drizzle-orm";
import type { z } from "zod";
import { env } from "../../config/env";
import { getDb } from "../../db/client";
import { events, clubs, resourceReservations, resourceUnits, resources } from "../../db/schema";
import {
  type AuthContext,
  canAccessDepartment,
  departmentScope,
  hasRole,
} from "../../middleware/auth";
import { ApiError } from "../../utils/api-error";
import { isUniqueViolation } from "../../utils/db-error";
import { type AuditContext, insertAudit } from "../audit/service";
import type {
  createResourceSchema,
  createUnitSchema,
  resourceListQuerySchema,
  updateResourceSchema,
  updateUnitSchema,
} from "./schemas";

type ResourceRow = typeof resources.$inferSelect;

/** Legacy DB identifiers/classification remain internal; users identify resources by name. */
function publicResource(resource: ResourceRow) {
  const { code: _code, kind: _kind, ...visible } = resource;
  return visible;
}

function publicUnit(unit: typeof resourceUnits.$inferSelect) {
  const { code: _code, ...visible } = unit;
  return visible;
}

/**
 * Admins manage institution-wide inventory.
 * HOD/Dean manages resources in their department scope.
 * Coordinators read availability but never edit inventory.
 */
export function canManageResources(auth: AuthContext): boolean {
  return hasRole(auth, "ADMIN") || hasRole(auth, "HOD_DEAN");
}

function assertResourceManageScope(auth: AuthContext, resource: ResourceRow) {
  if (hasRole(auth, "ADMIN")) return;
  if (hasRole(auth, "HOD_DEAN") && canAccessDepartment(auth, "HOD_DEAN", resource.departmentId))
    return;
  throw new ApiError("FORBIDDEN", "This resource is outside your management scope.");
}

function assertTargetDepartmentScope(auth: AuthContext, departmentId: string | null) {
  if (hasRole(auth, "ADMIN")) return;
  if (!departmentId)
    throw new ApiError(
      "FORBIDDEN",
      "HOD/Dean must assign resources to a department within their scope.",
    );
  if (!canAccessDepartment(auth, "HOD_DEAN", departmentId))
    throw new ApiError("FORBIDDEN", "Target department is outside your scope.");
}

/**
 * Is this reservation still allowed to block its window?
 *
 * A HELD row whose hold_expires_at has passed is *not* a hold any more — the
 * reservation writes it out as RELEASED, so a hold that expired between two job
 * runs is nobody's reservation. The calendar and the availability lookup used to
 * treat every HELD row as blocking until a background sweep rewrote it, which is
 * why a resource could look permanently taken by an approval that had already
 * timed out. Releasing is a background concern; *reporting* it is not.
 */
function isStillBlocking(
  reservation: { status: string; holdExpiresAt: Date | null },
  now: Date,
): boolean {
  if (
    reservation.status === "HELD" &&
    reservation.holdExpiresAt &&
    reservation.holdExpiresAt <= now
  )
    return false;
  return reservation.status === "HELD" || reservation.status === "CONFIRMED";
}

export async function listResources(
  auth: AuthContext,
  input: z.infer<typeof resourceListQuerySchema>,
) {
  const { db } = getDb();
  const filters: SQL[] = [];
  if (input.status) filters.push(eq(resources.status, input.status));
  if (input.departmentId) filters.push(eq(resources.departmentId, input.departmentId));
  if (input.q) {
    const q = ilike(resources.name, `%${input.q}%`);
    if (q) filters.push(q);
  }
  const where = filters.length ? and(...filters) : undefined;
  const rows = await db
    .select()
    .from(resources)
    .where(where)
    .orderBy(resources.name, resources.id)
    .limit(input.limit + 1)
    .offset(input.offset);
  const [totalRow] = await db.select({ n: count() }).from(resources).where(where);
  const pageRows = rows.slice(0, input.limit);
  const units = pageRows.length
    ? await db
        .select()
        .from(resourceUnits)
        .where(
          inArray(
            resourceUnits.resourceId,
            pageRows.map((r) => r.id),
          ),
        )
        .orderBy(resourceUnits.label)
    : [];
  return {
    items: pageRows.map((r) => ({
      ...publicResource(r),
      units: units.filter((u) => u.resourceId === r.id).map(publicUnit),
      canManage:
        hasRole(auth, "ADMIN") ||
        (hasRole(auth, "HOD_DEAN") && canAccessDepartment(auth, "HOD_DEAN", r.departmentId)),
    })),
    total: totalRow?.n ?? 0,
    limit: input.limit,
    offset: input.offset,
    hasMore: rows.length > input.limit,
  };
}

export async function getResource(id: string) {
  const { db } = getDb();
  const [resource] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
  if (!resource) throw new ApiError("NOT_FOUND", "Resource not found.");
  const units = await db
    .select()
    .from(resourceUnits)
    .where(eq(resourceUnits.resourceId, id))
    .orderBy(resourceUnits.label);
  return { ...publicResource(resource), units: units.map(publicUnit) };
}

export async function createResource(
  auth: AuthContext,
  input: z.infer<typeof createResourceSchema>,
  audit?: AuditContext,
) {
  if (!canManageResources(auth))
    throw new ApiError("FORBIDDEN", "Only admin or HOD/Dean can manage inventory.");
  const departmentId = input.departmentId ?? null;
  assertTargetDepartmentScope(auth, departmentId);
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [resource] = await tx
        .insert(resources)
        .values({
          // Keep the legacy enum/unique key internal. Classification is by the
          // resource name; generated identifiers are never shown to staff.
          kind: "OTHER",
          name: input.name,
          code: `RES-${randomUUID()}`,
          description: input.description ?? null,
          departmentId,
          capacity: input.capacity ?? null,
          metadata: input.metadata,
          createdBy: auth.user.id,
        })
        .returning();
      if (!resource) throw new ApiError("INTERNAL_ERROR", "Resource creation failed.");
      const unitRows = input.unitLabels.length
        ? await tx
            .insert(resourceUnits)
            .values(
              input.unitLabels.map((label) => ({
                resourceId: resource.id,
                label,
                code: `UNIT-${randomUUID()}`,
              })),
            )
            .returning()
        : [];
      if (audit)
        await insertAudit(tx, audit, {
          action: "RESOURCE_CREATED",
          entityType: "resource",
          entityId: resource.id,
          after: { name: resource.name, units: unitRows.length },
        });
      return { ...publicResource(resource), units: unitRows.map(publicUnit) };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "A resource unit label already exists.");
    throw err;
  }
}

export async function updateResource(
  auth: AuthContext,
  id: string,
  input: z.infer<typeof updateResourceSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [before] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
  if (!before) throw new ApiError("NOT_FOUND", "Resource not found.");
  assertResourceManageScope(auth, before);
  if (input.departmentId !== undefined) {
    assertTargetDepartmentScope(auth, input.departmentId ?? null);
  }
  // Retiring or maintaining a resource must not silently cancel confirmed bookings.
  if (input.status && input.status !== "ACTIVE") {
    const activeBookings = await db
      .select({ n: count() })
      .from(resourceReservations)
      .innerJoin(resourceUnits, eq(resourceUnits.id, resourceReservations.resourceUnitId))
      .where(
        and(
          eq(resourceUnits.resourceId, id),
          inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
          gt(resourceReservations.endsAt, new Date()),
        ),
      );
    if ((activeBookings[0]?.n ?? 0) > 0) {
      throw new ApiError(
        "CONFLICT",
        "This resource has upcoming holds or confirmations. Resolve them before taking it out of service.",
      );
    }
  }
  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(resources)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity ?? null } : {}),
          ...(input.departmentId !== undefined ? { departmentId: input.departmentId ?? null } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          updatedAt: new Date(),
        })
        .where(eq(resources.id, id))
        .returning();
      if (audit)
        await insertAudit(tx, audit, {
          action: "RESOURCE_UPDATED",
          entityType: "resource",
          entityId: id,
          before: { name: before.name, status: before.status, capacity: before.capacity },
          after: input,
        });
      return updated ? publicResource(updated) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "Resource could not be updated due to a uniqueness conflict.");
    throw err;
  }
}

export async function createUnit(
  auth: AuthContext,
  resourceId: string,
  input: z.infer<typeof createUnitSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [resource] = await db.select().from(resources).where(eq(resources.id, resourceId)).limit(1);
  if (!resource) throw new ApiError("NOT_FOUND", "Resource not found.");
  assertResourceManageScope(auth, resource);
  try {
    return await db.transaction(async (tx) => {
      const [unit] = await tx
        .insert(resourceUnits)
        .values({
          resourceId,
          label: input.label,
          code: `UNIT-${randomUUID()}`,
          notes: input.notes ?? null,
        })
        .returning();
      if (audit)
        await insertAudit(tx, audit, {
          action: "RESOURCE_UNIT_CREATED",
          entityType: "resource_unit",
          entityId: unit?.id,
          after: { resourceId, label: input.label },
        });
      return unit ? publicUnit(unit) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "A unit with that label already exists for this resource.");
    throw err;
  }
}

export async function updateUnit(
  auth: AuthContext,
  unitId: string,
  input: z.infer<typeof updateUnitSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [row] = await db
    .select({ unit: resourceUnits, resource: resources })
    .from(resourceUnits)
    .innerJoin(resources, eq(resources.id, resourceUnits.resourceId))
    .where(eq(resourceUnits.id, unitId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Resource unit not found.");
  assertResourceManageScope(auth, row.resource);
  if (input.status && input.status !== "ACTIVE") {
    const [bookings] = await db
      .select({ n: count() })
      .from(resourceReservations)
      .where(
        and(
          eq(resourceReservations.resourceUnitId, unitId),
          inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
          gt(resourceReservations.endsAt, new Date()),
        ),
      );
    if ((bookings?.n ?? 0) > 0)
      throw new ApiError(
        "CONFLICT",
        "This unit has upcoming holds or confirmations. Resolve them before taking it out of service.",
      );
  }
  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(resourceUnits)
        .set({
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
        })
        .where(eq(resourceUnits.id, unitId))
        .returning();
      if (audit)
        await insertAudit(tx, audit, {
          action: "RESOURCE_UNIT_UPDATED",
          entityType: "resource_unit",
          entityId: unitId,
          before: { label: row.unit.label, status: row.unit.status },
          after: input,
        });
      return updated ? publicUnit(updated) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "Unit label already exists for this resource.");
    throw err;
  }
}

/** Per-unit availability for a window. Busy blocks never leak other clubs' details. */
export async function availability(input: {
  startsAt: string;
  endsAt: string;
  departmentId?: string | undefined;
  resourceId?: string | undefined;
  limit: number;
  offset: number;
}) {
  const { db } = getDb();
  const window = { startsAt: input.startsAt, endsAt: input.endsAt };
  if (new Date(input.endsAt) <= new Date(input.startsAt))
    throw new ApiError("VALIDATION_ERROR", "endsAt must be after startsAt.");

  const filters: SQL[] = [];
  if (input.departmentId) filters.push(eq(resources.departmentId, input.departmentId));
  if (input.resourceId) filters.push(eq(resources.id, input.resourceId));
  const rows = await db
    .select({ unit: resourceUnits, resource: resources })
    .from(resourceUnits)
    .innerJoin(resources, eq(resources.id, resourceUnits.resourceId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(resources.name, resourceUnits.label, resourceUnits.id)
    .limit(input.limit + 1)
    .offset(input.offset);
  const pageRows = rows.slice(0, input.limit);
  const unitIds = pageRows.map((r) => r.unit.id);
  const reservations = unitIds.length
    ? await db
        .select()
        .from(resourceReservations)
        .where(
          and(
            inArray(resourceReservations.resourceUnitId, unitIds),
            inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
            lt(resourceReservations.startsAt, new Date(input.endsAt)),
            gt(resourceReservations.endsAt, new Date(input.startsAt)),
          ),
        )
    : [];
  const now = new Date();
  return {
    window,
    items: pageRows.map(({ unit, resource }) => {
      const busy = reservations.filter(
        (r) => r.resourceUnitId === unit.id && isStillBlocking(r, now),
      );
      const bookable = unit.status === "ACTIVE" && resource.status === "ACTIVE";
      return {
        resourceUnitId: unit.id,
        unitLabel: unit.label,
        unitStatus: unit.status,
        resourceId: resource.id,
        resourceName: resource.name,
        resourceStatus: resource.status,
        departmentId: resource.departmentId,
        capacity: resource.capacity,
        available: bookable && busy.length === 0,
        busyBlocks: mergeRanges(busy.map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt }))),
      };
    }),
    limit: input.limit,
    offset: input.offset,
    hasMore: rows.length > input.limit,
  };
}

/** Calendar grid: one row per unit, with busy blocks and event titles for scoped staff. */
export async function calendar(
  auth: AuthContext,
  input: {
    startsAt: string;
    endsAt: string;
    resourceId?: string | undefined;
    departmentId?: string | undefined;
  },
) {
  const { db } = getDb();
  if (new Date(input.endsAt) <= new Date(input.startsAt))
    throw new ApiError("VALIDATION_ERROR", "endsAt must be after startsAt.");
  const spanDays =
    (new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime()) / 86_400_000;
  if (spanDays > 62)
    throw new ApiError("VALIDATION_ERROR", "Calendar window is limited to 62 days.");

  const filters: SQL[] = [];
  if (input.resourceId) filters.push(eq(resources.id, input.resourceId));
  if (input.departmentId) filters.push(eq(resources.departmentId, input.departmentId));
  const units = await db
    .select({ unit: resourceUnits, resource: resources })
    .from(resourceUnits)
    .innerJoin(resources, eq(resources.id, resourceUnits.resourceId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(resources.name, resourceUnits.label)
    .limit(env.RESOURCE_AVAILABILITY_MAX_UNITS);
  const unitIds = units.map((u) => u.unit.id);
  const rows = unitIds.length
    ? await db
        .select({
          reservation: resourceReservations,
          eventTitle: events.title,
          eventStatus: events.status,
          eventClubId: events.clubId,
          clubName: clubs.name,
          clubDepartmentId: clubs.departmentId,
        })
        .from(resourceReservations)
        .innerJoin(events, eq(events.id, resourceReservations.eventId))
        .innerJoin(clubs, eq(clubs.id, events.clubId))
        .where(
          and(
            inArray(resourceReservations.resourceUnitId, unitIds),
            inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
            lt(resourceReservations.startsAt, new Date(input.endsAt)),
            gt(resourceReservations.endsAt, new Date(input.startsAt)),
          ),
        )
        .orderBy(resourceReservations.startsAt)
    : [];

  const myClubIds = new Set(auth.memberships.map((m) => m.clubId));
  const senior = departmentScope(auth, "HOD_DEAN");
  const now = new Date();
  return {
    window: { startsAt: input.startsAt, endsAt: input.endsAt },
    rows: units.map(({ unit, resource }) => ({
      resourceUnitId: unit.id,
      unitLabel: unit.label,
      unitStatus: unit.status,
      resourceName: resource.name,
      resourceStatus: resource.status,
      capacity: resource.capacity,
      bookings: rows
        .filter(
          (r) => r.reservation.resourceUnitId === unit.id && isStillBlocking(r.reservation, now),
        )
        .map((r) => {
          const canSeeDetail =
            hasRole(auth, "ADMIN") ||
            myClubIds.has(r.eventClubId) ||
            (hasRole(auth, "HOD_DEAN") &&
              (senior.global ||
                (r.clubDepartmentId !== null &&
                  senior.departmentIds.includes(r.clubDepartmentId))));
          return {
            reservationId: r.reservation.id,
            startsAt: r.reservation.startsAt,
            endsAt: r.reservation.endsAt,
            status: r.reservation.status,
            eventId: canSeeDetail ? r.reservation.eventId : null,
            eventStatus: canSeeDetail ? r.eventStatus : null,
            clubName: canSeeDetail ? r.clubName : null,
            title: canSeeDetail ? r.eventTitle : "Reserved",
          };
        }),
    })),
  };
}

export async function eventReservations(eventId: string) {
  const { db } = getDb();
  return db
    .select({
      reservation: resourceReservations,
      unit: {
        id: resourceUnits.id,
        resourceId: resourceUnits.resourceId,
        label: resourceUnits.label,
        status: resourceUnits.status,
        notes: resourceUnits.notes,
        createdAt: resourceUnits.createdAt,
      },
      resource: { id: resources.id, name: resources.name },
    })
    .from(resourceReservations)
    .innerJoin(resourceUnits, eq(resourceUnits.id, resourceReservations.resourceUnitId))
    .innerJoin(resources, eq(resources.id, resourceUnits.resourceId))
    .where(eq(resourceReservations.eventId, eventId))
    .orderBy(resourceReservations.startsAt);
}

/** Shared conflict pre-check used by approvals before attempting held inserts. */
export function explainConflicts(
  proposed: Array<{ resourceUnitId: string; startsAt: string; endsAt: string }>,
  existing: Array<{
    resourceUnitId: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    eventId: string;
  }>,
  unitLabels: Map<string, string>,
  ownEventId: string,
): string[] {
  const messages: string[] = [];
  for (const p of proposed) {
    const clashes = existing.filter(
      (e) =>
        e.resourceUnitId === p.resourceUnitId &&
        e.eventId !== ownEventId &&
        (e.status === "HELD" || e.status === "CONFIRMED") &&
        rangesOverlap(
          { startsAt: e.startsAt, endsAt: e.endsAt },
          { startsAt: p.startsAt, endsAt: p.endsAt },
        ),
    );
    if (clashes.length > 0) {
      messages.push(
        `${unitLabels.get(p.resourceUnitId) ?? p.resourceUnitId} is already booked in the requested window.`,
      );
    }
  }
  return messages;
}
