import {
  ACTIVE_RESERVATION_STATUSES,
  type ApprovalTier,
  DECISION_RESULT_STATUS,
  type DecisionAction,
  NEXT_TIER,
  TIER_ROLE,
  canActOnApproval,
  canEscalateTo,
  summarizeBundle,
  validateBundleComposition,
} from "@campusops/shared";
import { type SQL, and, asc, count, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { z } from "zod";
import { env } from "../../config/env";
import { type DbClient, getDb } from "../../db/client";
import {
  events,
  approvalActions,
  approvalBundles,
  approvalRequestResources,
  approvalRequests,
  clubs,
  eventRevisions,
  resourceReservations,
  resourceUnits,
  resources,
  roleAssignments,
  users,
} from "../../db/schema";
import {
  type AuthContext,
  canAccessDepartment,
  departmentScope,
  hasRole,
} from "../../middleware/auth";
import { hasEventOversight, isClubCoordinator } from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { isExclusionViolation, isUniqueViolation } from "../../utils/db-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { queueNotification } from "../notifications/outbox";
import type {
  addApprovalRequestSchema,
  approvalInboxQuerySchema,
  attachResourcesSchema,
  cancelRequestSchema,
  decisionSchema,
  escalateSchema,
  reassignSchema,
} from "./schemas";

type Tx = Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0];
type RequestRow = typeof approvalRequests.$inferSelect;

export type ResourceRequestInput = {
  resourceUnitId: string;
  startsAt: string;
  endsAt: string;
};

/** Resolve the club + department behind a request, for scope and queue checks. */
async function requestContext(executor: Tx | DbClient["db"], requestId: string) {
  const [row] = await executor
    .select({
      request: approvalRequests,
      bundle: approvalBundles,
      event: events,
      club: clubs,
    })
    .from(approvalRequests)
    .innerJoin(approvalBundles, eq(approvalBundles.id, approvalRequests.bundleId))
    .innerJoin(events, eq(events.id, approvalBundles.eventId))
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .where(eq(approvalRequests.id, requestId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Approval request not found.");
  return row;
}

function assertAuthority(auth: AuthContext, ctx: Awaited<ReturnType<typeof requestContext>>): void {
  const allowed = canActOnApproval({
    actorId: auth.user.id,
    actorRoles: auth.roles.map((r) => ({
      role: r.role,
      scopeType: r.scopeType,
      departmentId: r.departmentId,
    })),
    currentTier: ctx.request.currentTier,
    assignedApproverId: ctx.request.assignedApproverId,
    clubDepartmentId: ctx.club.departmentId,
  });
  if (!allowed)
    throw new ApiError("FORBIDDEN", "This request is not assigned to your approval authority.");
}

function assertPending(request: RequestRow) {
  if (request.status !== "PENDING")
    throw new ApiError(
      "CONFLICT",
      `This request is already ${request.status}. Refresh to see the latest state.`,
    );
}

function assertVersion(request: RequestRow, expectedVersion: number) {
  if (request.version !== expectedVersion)
    throw new ApiError(
      "STALE_APPROVAL_VERSION",
      "This request changed since you opened it. Reload before deciding.",
      { currentVersion: request.version, expectedVersion },
    );
}

/** Verify an assignee actually holds the role required by the tier. */
async function assertAssigneeForTier(
  executor: Tx | DbClient["db"],
  assigneeId: string,
  tier: ApprovalTier,
  clubDepartmentId: string | null,
) {
  const [row] = await executor
    .select({ user: users })
    .from(users)
    .where(and(eq(users.id, assigneeId), eq(users.status, "ACTIVE")))
    .limit(1);
  if (!row) throw new ApiError("APPROVER_UNAVAILABLE", "The selected approver is not active.");
  const roles = await executor
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.userId, assigneeId),
        eq(roleAssignments.role, TIER_ROLE[tier]),
        eq(roleAssignments.isActive, true),
      ),
    );
  if (roles.length === 0)
    throw new ApiError(
      "APPROVER_UNAVAILABLE",
      `The selected approver does not hold the ${TIER_ROLE[tier]} role.`,
    );
  if (tier === "SENIOR") {
    const scoped = roles.some(
      (r) =>
        r.scopeType === "GLOBAL" ||
        (clubDepartmentId !== null && r.departmentId === clubDepartmentId),
    );
    if (!scoped)
      throw new ApiError(
        "APPROVER_UNAVAILABLE",
        "The selected HOD/Dean does not cover this club's department.",
      );
  }
}

/**
 * Create HELD reservations for a resource request inside the caller's transaction.
 * The PostgreSQL exclusion constraint is the final arbiter of overlap.
 */
export async function holdResources(
  tx: Tx,
  params: {
    requestId: string;
    eventId: string;
    resources: ResourceRequestInput[];
  },
) {
  if (params.resources.length === 0) return [];
  const unitIds = [...new Set(params.resources.map((r) => r.resourceUnitId))];
  const units = await tx
    .select({ unit: resourceUnits, resource: resources })
    .from(resourceUnits)
    .innerJoin(resources, eq(resources.id, resourceUnits.resourceId))
    .where(inArray(resourceUnits.id, unitIds));
  const byId = new Map(units.map((u) => [u.unit.id, u]));

  for (const item of params.resources) {
    const found = byId.get(item.resourceUnitId);
    if (!found) throw new ApiError("NOT_FOUND", "Resource unit not found.");
    if (found.unit.status !== "ACTIVE" || found.resource.status !== "ACTIVE")
      throw new ApiError(
        "RESOURCE_CONFLICT",
        `${found.unit.label} is not currently bookable (${found.unit.status}/${found.resource.status}).`,
      );
    if (new Date(item.endsAt) <= new Date(item.startsAt))
      throw new ApiError("VALIDATION_ERROR", "Resource window must end after it starts.");
    if (new Date(item.endsAt) <= new Date())
      throw new ApiError("VALIDATION_ERROR", "Resource windows must be in the future.");
  }
  // Reject duplicate units in one request: the PK is (request, unit).
  if (unitIds.length !== params.resources.length)
    throw new ApiError(
      "VALIDATION_ERROR",
      "List each resource unit once per request; use separate requests for separate windows.",
    );

  await tx.insert(approvalRequestResources).values(
    params.resources.map((r) => ({
      requestId: params.requestId,
      resourceUnitId: r.resourceUnitId,
      startsAt: new Date(r.startsAt),
      endsAt: new Date(r.endsAt),
    })),
  );

  const holdExpiresAt = new Date(Date.now() + env.RESOURCE_HOLD_TTL_HOURS * 3_600_000);
  try {
    const inserted = await tx
      .insert(resourceReservations)
      .values(
        params.resources.map((r) => ({
          requestId: params.requestId,
          resourceUnitId: r.resourceUnitId,
          eventId: params.eventId,
          startsAt: new Date(r.startsAt),
          endsAt: new Date(r.endsAt),
          status: "HELD" as const,
          holdExpiresAt,
        })),
      )
      .returning();
    return inserted;
  } catch (err) {
    if (isExclusionViolation(err)) {
      const labels = params.resources.map(
        (r) => byId.get(r.resourceUnitId)?.unit.label ?? r.resourceUnitId,
      );
      throw new ApiError(
        "RESOURCE_CONFLICT",
        `Requested resource is already held or confirmed for that window: ${labels.join(", ")}.`,
        { resourceUnitIds: params.resources.map((r) => r.resourceUnitId) },
      );
    }
    throw err;
  }
}

/** Release every active reservation belonging to a request. */
async function releaseRequestHolds(tx: Tx, requestId: string, reason: string) {
  await tx
    .update(resourceReservations)
    .set({ status: "RELEASED", releasedAt: new Date(), releaseReason: reason })
    .where(
      and(
        eq(resourceReservations.requestId, requestId),
        inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
      ),
    );
}

async function confirmRequestHolds(tx: Tx, requestId: string) {
  const active = await tx
    .select()
    .from(resourceReservations)
    .where(
      and(
        eq(resourceReservations.requestId, requestId),
        inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
      ),
    );
  const now = new Date();
  const expired = active.filter(
    (r) => r.status === "HELD" && r.holdExpiresAt !== null && r.holdExpiresAt <= now,
  );
  if (expired.length > 0) {
    throw new ApiError(
      "HOLD_EXPIRED",
      "The resource hold expired. The coordinator must request the resource again.",
      { reservationIds: expired.map((r) => r.id) },
    );
  }
  await tx
    .update(resourceReservations)
    .set({ status: "CONFIRMED", confirmedAt: now, holdExpiresAt: null })
    .where(
      and(eq(resourceReservations.requestId, requestId), eq(resourceReservations.status, "HELD")),
    );
}

/** Recompute READY / PENDING_APPROVALS from the current bundle. Caller owns the transaction. */
export async function syncEventApprovalState(tx: Tx, eventId: string) {
  const [bundle] = await tx
    .select()
    .from(approvalBundles)
    .where(and(eq(approvalBundles.eventId, eventId), isNull(approvalBundles.supersededAt)))
    .limit(1);
  const [event] = await tx.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event || !bundle) return null;
  if (event.status !== "PENDING_APPROVALS" && event.status !== "READY") return event;

  const requests = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.bundleId, bundle.id));
  const summary = summarizeBundle(requests);
  const nextStatus = summary.readyToPublish ? "READY" : "PENDING_APPROVALS";
  if (nextStatus === event.status) return event;
  const [updated] = await tx
    .update(events)
    .set({
      status: nextStatus,
      readyAt: nextStatus === "READY" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(events.id, eventId))
    .returning();
  return updated ?? event;
}

export async function inbox(auth: AuthContext, input: z.infer<typeof approvalInboxQuerySchema>) {
  const { db } = getDb();
  const tiers: ApprovalTier[] = [];
  if (hasRole(auth, "FACULTY")) tiers.push("FACULTY");
  if (hasRole(auth, "HOD_DEAN")) tiers.push("SENIOR");
  if (hasRole(auth, "ADMIN")) tiers.push("ADMIN");
  if (input.tier) {
    if (!tiers.includes(input.tier))
      return { items: [], total: 0, limit: input.limit, offset: input.offset, hasMore: false };
    tiers.length = 0;
    tiers.push(input.tier);
  }
  const empty = {
    items: [],
    total: 0,
    limit: input.limit,
    offset: input.offset,
    hasMore: false,
    counts: { assigned: 0, queue: 0, all: 0 },
  };
  if (tiers.length === 0) return empty;

  const senior = departmentScope(auth, "HOD_DEAN");
  const assignedClause = eq(approvalRequests.assignedApproverId, auth.user.id);
  const queueClauses: SQL[] = [];
  if (tiers.includes("ADMIN")) {
    queueClauses.push(
      and(
        eq(approvalRequests.currentTier, "ADMIN"),
        isNull(approvalRequests.assignedApproverId),
      ) as SQL,
    );
  }
  if (tiers.includes("SENIOR")) {
    queueClauses.push(
      and(
        eq(approvalRequests.currentTier, "SENIOR"),
        isNull(approvalRequests.assignedApproverId),
        senior.global
          ? undefined
          : inArray(
              clubs.departmentId,
              senior.departmentIds.length
                ? senior.departmentIds
                : ["00000000-0000-0000-0000-000000000000"],
            ),
      ) as SQL,
    );
  }
  const scopeClause =
    input.scope === "assigned"
      ? assignedClause
      : input.scope === "queue"
        ? queueClauses.length
          ? or(...queueClauses)
          : undefined
        : queueClauses.length
          ? or(assignedClause, ...queueClauses)
          : assignedClause;
  if (!scopeClause) return empty;

  const baseClauses = [
    inArray(approvalRequests.currentTier, tiers),
    input.status
      ? eq(approvalRequests.status, input.status)
      : eq(approvalRequests.status, "PENDING"),
    isNull(approvalBundles.supersededAt),
  ];
  const where = and(...baseClauses, scopeClause);
  const queueScope = queueClauses.length ? or(...queueClauses) : undefined;
  const countFor = async (clause: SQL | undefined) => {
    if (!clause) return 0;
    const [row] = await db
      .select({ n: count() })
      .from(approvalRequests)
      .innerJoin(approvalBundles, eq(approvalBundles.id, approvalRequests.bundleId))
      .innerJoin(events, eq(events.id, approvalBundles.eventId))
      .innerJoin(clubs, eq(clubs.id, events.clubId))
      .where(and(...baseClauses, clause));
    return row?.n ?? 0;
  };
  const [assignedCount, queueCount] = await Promise.all([
    countFor(assignedClause),
    countFor(queueScope),
  ]);
  const rows = await db
    .select({
      request: approvalRequests,
      event: {
        id: events.id,
        title: events.title,
        startsAt: events.startsAt,
        status: events.status,
      },
      club: { id: clubs.id, name: clubs.name, departmentId: clubs.departmentId },
    })
    .from(approvalRequests)
    .innerJoin(approvalBundles, eq(approvalBundles.id, approvalRequests.bundleId))
    .innerJoin(events, eq(events.id, approvalBundles.eventId))
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .where(where)
    .orderBy(asc(approvalRequests.tierEnteredAt), asc(approvalRequests.id))
    .limit(input.limit + 1)
    .offset(input.offset);
  const [totalRow] = await db
    .select({ n: count() })
    .from(approvalRequests)
    .innerJoin(approvalBundles, eq(approvalBundles.id, approvalRequests.bundleId))
    .innerJoin(events, eq(events.id, approvalBundles.eventId))
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .where(where);
  return {
    items: rows.slice(0, input.limit),
    total: totalRow?.n ?? 0,
    limit: input.limit,
    offset: input.offset,
    hasMore: rows.length > input.limit,
    counts: { assigned: assignedCount, queue: queueCount, all: assignedCount + queueCount },
  };
}

export async function getRequest(auth: AuthContext, requestId: string) {
  const { db } = getDb();
  const ctx = await requestContext(db, requestId);
  const canRead =
    isClubCoordinator(auth, ctx.event.clubId) ||
    hasEventOversight(auth, ctx.club.departmentId) ||
    hasRole(auth, "FACULTY") ||
    ctx.request.assignedApproverId === auth.user.id;
  if (!canRead) throw new ApiError("NOT_FOUND", "Approval request not found.");
  const actions = await db
    .select({
      action: approvalActions,
      actor: { id: users.id, fullName: users.fullName },
    })
    .from(approvalActions)
    .innerJoin(users, eq(users.id, approvalActions.actorId))
    .where(eq(approvalActions.requestId, requestId))
    .orderBy(approvalActions.createdAt, approvalActions.id);
  const requested = await db
    .select({
      link: approvalRequestResources,
      unit: { id: resourceUnits.id, label: resourceUnits.label },
      resource: { id: resources.id, name: resources.name },
    })
    .from(approvalRequestResources)
    .innerJoin(resourceUnits, eq(resourceUnits.id, approvalRequestResources.resourceUnitId))
    .innerJoin(resources, eq(resources.id, resourceUnits.resourceId))
    .where(eq(approvalRequestResources.requestId, requestId));
  const reservations = await db
    .select()
    .from(resourceReservations)
    .where(eq(resourceReservations.requestId, requestId));
  return { ...ctx, actions, resources: requested, reservations };
}

export async function eventBundle(auth: AuthContext, eventId: string) {
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  const [club] = await db.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);
  const canRead =
    isClubCoordinator(auth, event.clubId) ||
    hasEventOversight(auth, club?.departmentId ?? null) ||
    hasRole(auth, "FACULTY");
  if (!canRead) throw new ApiError("NOT_FOUND", "Event not found.");
  const [bundle] = await db
    .select()
    .from(approvalBundles)
    .where(and(eq(approvalBundles.eventId, eventId), isNull(approvalBundles.supersededAt)))
    .limit(1);
  if (!bundle)
    return { event, club, bundle: null, requests: [], summary: summarizeBundle([]), history: [] };
  const requests = await db
    .select({
      request: approvalRequests,
      assignee: { id: users.id, fullName: users.fullName, email: users.email },
    })
    .from(approvalRequests)
    .leftJoin(users, eq(users.id, approvalRequests.assignedApproverId))
    .where(eq(approvalRequests.bundleId, bundle.id))
    .orderBy(approvalRequests.createdAt, approvalRequests.id);
  const requestIds = requests.map((r) => r.request.id);
  const actionRows = requestIds.length
    ? await db
        .select({
          action: approvalActions,
          actor: { id: users.id, fullName: users.fullName },
        })
        .from(approvalActions)
        .innerJoin(users, eq(users.id, approvalActions.actorId))
        .where(inArray(approvalActions.requestId, requestIds))
        .orderBy(desc(approvalActions.createdAt), desc(approvalActions.id))
    : [];
  const lastActionByRequest = new Map<string, (typeof actionRows)[number]>();
  for (const row of actionRows)
    if (!lastActionByRequest.has(row.action.requestId))
      lastActionByRequest.set(row.action.requestId, row);
  const withResources = await Promise.all(
    requests.map(async (r) => {
      const links = await db
        .select({
          link: approvalRequestResources,
          unit: { id: resourceUnits.id, label: resourceUnits.label },
        })
        .from(approvalRequestResources)
        .innerJoin(resourceUnits, eq(resourceUnits.id, approvalRequestResources.resourceUnitId))
        .where(eq(approvalRequestResources.requestId, r.request.id));
      return { ...r, resources: links, lastAction: lastActionByRequest.get(r.request.id) ?? null };
    }),
  );
  const titles = new Map(requests.map((r) => [r.request.id, r.request.title]));
  return {
    event,
    club,
    bundle,
    requests: withResources,
    summary: summarizeBundle(requests.map((r) => r.request)),
    // Newest first: the overview renders this as the event's approval history.
    history: actionRows.map((row) => ({
      ...row,
      requestTitle: titles.get(row.action.requestId) ?? "Approval request",
    })),
  };
}

export async function decide(
  auth: AuthContext,
  requestId: string,
  input: z.infer<typeof decisionSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const result = await db.transaction(async (tx) => {
    // Row lock serialises concurrent decisions on the same request.
    const [locked] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .for("update");
    if (!locked) throw new ApiError("NOT_FOUND", "Approval request not found.");
    const ctx = await requestContext(tx, requestId);
    if (ctx.bundle.supersededAt)
      throw new ApiError("CONFLICT", "This request belongs to a superseded event revision.");
    assertAuthority(auth, ctx);
    assertPending(locked);
    assertVersion(locked, input.expectedVersion);

    const nextStatus = DECISION_RESULT_STATUS[input.action as DecisionAction];
    if (input.action === "APPROVE" && locked.type === "RESOURCE_USE") {
      // A resource hold is a commitment of the event as submitted. If a reviewer
      // has sent the event back for changes — or a required rejection returned it
      // to draft — approving the room/lab before the coordinator fixes the event
      // would reserve campus space for something that is still moving.
      const bundleRequests = await tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.bundleId, locked.bundleId));
      const openChange = bundleRequests.some(
        (request) =>
          request.id !== requestId && request.isRequired && request.status === "CHANGES_REQUESTED",
      );
      if (ctx.event.status === "DRAFT" || openChange)
        throw new ApiError(
          "CONFLICT",
          "The event has requested changes. The coordinator must fix and resubmit it before its resources can be approved.",
        );
    }
    if (input.action === "APPROVE") {
      await confirmRequestHolds(tx, requestId);
    } else {
      await releaseRequestHolds(tx, requestId, `${input.action}: ${input.comment ?? ""}`.trim());
    }

    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status: nextStatus,
        version: locked.version + 1,
        decidedAt: input.action === "REQUEST_CHANGES" ? null : new Date(),
        decidedBy: input.action === "REQUEST_CHANGES" ? null : auth.user.id,
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, requestId))
      .returning();

    await tx.insert(approvalActions).values({
      requestId,
      actorId: auth.user.id,
      action: input.action,
      fromTier: locked.currentTier,
      toTier: locked.currentTier,
      fromStatus: locked.status,
      toStatus: nextStatus,
      comment: input.comment ?? null,
      requestVersion: locked.version,
    });

    // A required rejection sends the event back to draft for a new revision.
    if (
      input.action === "REJECT" &&
      locked.isRequired &&
      ctx.event.status === "PENDING_APPROVALS"
    ) {
      await tx
        .update(events)
        .set({ status: "DRAFT", readyAt: null, updatedAt: new Date() })
        .where(eq(events.id, ctx.event.id));
    }
    const event = await syncEventApprovalState(tx, ctx.event.id);

    if (audit)
      await insertAudit(tx, audit, {
        action: `APPROVAL_${input.action}`,
        entityType: "approval_request",
        entityId: requestId,
        clubId: ctx.club.id,
        eventId: ctx.event.id,
        before: { status: locked.status, version: locked.version, tier: locked.currentTier },
        after: { status: nextStatus, version: locked.version + 1, comment: input.comment },
      });

    await queueNotification(tx, {
      kind: `APPROVAL_${input.action}`,
      recipientUserId: ctx.request.createdBy,
      eventId: ctx.event.id,
      approvalRequestId: requestId,
      subject: `${ctx.event.title}: ${locked.title} — ${nextStatus}`,
      body: `Your request "${locked.title}" for ${ctx.event.title} is now ${nextStatus}.${input.comment ? `\n\nComment: ${input.comment}` : ""}`,
    });

    return { request: updated, event, club: ctx.club };
  });
  return result;
}

export async function escalate(
  auth: AuthContext,
  requestId: string,
  input: z.infer<typeof escalateSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .for("update");
    if (!locked) throw new ApiError("NOT_FOUND", "Approval request not found.");
    const ctx = await requestContext(tx, requestId);
    if (ctx.bundle.supersededAt)
      throw new ApiError("CONFLICT", "This request belongs to a superseded event revision.");
    assertAuthority(auth, ctx);
    assertPending(locked);
    assertVersion(locked, input.expectedVersion);
    if (!canEscalateTo(locked.currentTier, input.toTier))
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        `Cannot escalate from ${locked.currentTier} to ${input.toTier}. The next tier is ${NEXT_TIER[locked.currentTier] ?? "none"}.`,
      );
    const assigneeId = input.assigneeId ?? null;
    if (assigneeId) {
      await assertAssigneeForTier(tx, assigneeId, input.toTier, ctx.club.departmentId);
    }

    const [updated] = await tx
      .update(approvalRequests)
      .set({
        currentTier: input.toTier,
        assignedApproverId: assigneeId,
        version: locked.version + 1,
        tierEnteredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, requestId))
      .returning();

    await tx.insert(approvalActions).values({
      requestId,
      actorId: auth.user.id,
      action: "ESCALATE",
      fromTier: locked.currentTier,
      toTier: input.toTier,
      fromStatus: locked.status,
      toStatus: "PENDING",
      comment: input.comment,
      requestVersion: locked.version,
    });

    if (audit)
      await insertAudit(tx, audit, {
        action: "APPROVAL_ESCALATED",
        entityType: "approval_request",
        entityId: requestId,
        clubId: ctx.club.id,
        eventId: ctx.event.id,
        before: { tier: locked.currentTier, assigneeId: locked.assignedApproverId },
        after: { tier: input.toTier, assigneeId, comment: input.comment },
      });

    await queueNotification(tx, {
      kind: "APPROVAL_ESCALATED",
      recipientUserId: assigneeId,
      eventId: ctx.event.id,
      approvalRequestId: requestId,
      subject: `${ctx.event.title}: approval escalated to ${input.toTier}`,
      body: `"${locked.title}" was escalated to the ${input.toTier} tier.\n\nReason: ${input.comment}`,
      fallbackTier: input.toTier,
    });

    return { request: updated, event: ctx.event };
  });
}

export async function reassign(
  auth: AuthContext,
  requestId: string,
  input: z.infer<typeof reassignSchema>,
  audit?: AuditContext,
) {
  if (!hasRole(auth, "ADMIN"))
    throw new ApiError("FORBIDDEN", "Only admin can reassign approval requests.");
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .for("update");
    if (!locked) throw new ApiError("NOT_FOUND", "Approval request not found.");
    const ctx = await requestContext(tx, requestId);
    assertPending(locked);
    assertVersion(locked, input.expectedVersion);
    if (input.assigneeId)
      await assertAssigneeForTier(tx, input.assigneeId, locked.currentTier, ctx.club.departmentId);
    if (locked.currentTier === "FACULTY" && !input.assigneeId)
      throw new ApiError("VALIDATION_ERROR", "The faculty tier requires a named approver.");

    const [updated] = await tx
      .update(approvalRequests)
      .set({
        assignedApproverId: input.assigneeId,
        version: locked.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, requestId))
      .returning();
    await tx.insert(approvalActions).values({
      requestId,
      actorId: auth.user.id,
      action: "REASSIGN",
      fromTier: locked.currentTier,
      toTier: locked.currentTier,
      fromStatus: locked.status,
      toStatus: locked.status,
      comment: input.reason,
      requestVersion: locked.version,
    });
    if (audit)
      await insertAudit(tx, audit, {
        action: "APPROVAL_REASSIGNED",
        entityType: "approval_request",
        entityId: requestId,
        clubId: ctx.club.id,
        eventId: ctx.event.id,
        before: { assigneeId: locked.assignedApproverId },
        after: { assigneeId: input.assigneeId, reason: input.reason },
      });
    await queueNotification(tx, {
      kind: "APPROVAL_REASSIGNED",
      recipientUserId: input.assigneeId,
      eventId: ctx.event.id,
      approvalRequestId: requestId,
      subject: `${ctx.event.title}: an approval was assigned to you`,
      body: `"${locked.title}" is now assigned to you.\n\nReason: ${input.reason}`,
    });
    return updated;
  });
}

export async function cancelRequest(
  auth: AuthContext,
  requestId: string,
  input: z.infer<typeof cancelRequestSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .for("update");
    if (!locked) throw new ApiError("NOT_FOUND", "Approval request not found.");
    const ctx = await requestContext(tx, requestId);
    if (!isClubCoordinator(auth, ctx.event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's coordinators can withdraw its approval requests.",
      );
    if (locked.status === "CANCELLED")
      throw new ApiError("CONFLICT", "This request is already cancelled.");
    assertVersion(locked, input.expectedVersion);

    await releaseRequestHolds(tx, requestId, `Withdrawn: ${input.reason}`);
    const [updated] = await tx
      .update(approvalRequests)
      .set({ status: "CANCELLED", version: locked.version + 1, updatedAt: new Date() })
      .where(eq(approvalRequests.id, requestId))
      .returning();
    await tx.insert(approvalActions).values({
      requestId,
      actorId: auth.user.id,
      action: "CANCEL",
      fromTier: locked.currentTier,
      toTier: locked.currentTier,
      fromStatus: locked.status,
      toStatus: "CANCELLED",
      comment: input.reason,
      requestVersion: locked.version,
    });
    const event = await syncEventApprovalState(tx, ctx.event.id);
    if (audit)
      await insertAudit(tx, audit, {
        action: "APPROVAL_CANCELLED",
        entityType: "approval_request",
        entityId: requestId,
        clubId: ctx.club.id,
        eventId: ctx.event.id,
        before: { status: locked.status },
        after: { status: "CANCELLED", reason: input.reason },
      });
    return { request: updated, event };
  });
}

/** Coordinator adds an individual request to the event's current bundle. */
export async function addRequest(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof addApprovalRequestSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
      if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
      if (!isClubCoordinator(auth, event.clubId))
        throw new ApiError(
          "FORBIDDEN",
          "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
        );
      if (event.status !== "PENDING_APPROVALS" && event.status !== "READY")
        throw new ApiError(
          "CONFLICT",
          "Requests can only be added while the event is awaiting approvals.",
        );
      const [bundle] = await tx
        .select()
        .from(approvalBundles)
        .where(and(eq(approvalBundles.eventId, eventId), isNull(approvalBundles.supersededAt)))
        .limit(1);
      if (!bundle) throw new ApiError("CONFLICT", "Submit the event for approval first.");
      const [club] = await tx.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);

      if (input.type === "RESOURCE_USE" && input.resources.length === 0)
        throw new ApiError("VALIDATION_ERROR", "A resource request must name at least one unit.");
      if (input.type !== "RESOURCE_USE" && input.resources.length > 0)
        throw new ApiError("VALIDATION_ERROR", "Only RESOURCE_USE requests can hold resources.");

      const existing = await tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.bundleId, bundle.id));
      const problems = validateBundleComposition(
        [...existing, { type: input.type, isRequired: input.isRequired }],
        event.audience,
      );
      if (problems.length > 0)
        throw new ApiError("VALIDATION_ERROR", problems.join(" "), { problems });

      const assigneeId = input.assignedApproverId ?? null;
      if (!assigneeId)
        throw new ApiError("VALIDATION_ERROR", "Name the faculty member who should decide this.");
      await assertAssigneeForTier(tx, assigneeId, "FACULTY", club?.departmentId ?? null);

      const [request] = await tx
        .insert(approvalRequests)
        .values({
          bundleId: bundle.id,
          type: input.type,
          title: input.title,
          description: input.description ?? null,
          isRequired: input.isRequired,
          currentTier: "FACULTY",
          assignedApproverId: assigneeId,
          createdBy: auth.user.id,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
        })
        .returning();
      if (!request) throw new ApiError("INTERNAL_ERROR", "Request creation failed.");

      await holdResources(tx, {
        requestId: request.id,
        eventId,
        resources: input.resources,
      });
      await tx.insert(approvalActions).values({
        requestId: request.id,
        actorId: auth.user.id,
        action: "SUBMIT",
        toTier: "FACULTY",
        toStatus: "PENDING",
        requestVersion: 1,
      });
      const updatedEvent = await syncEventApprovalState(tx, eventId);
      if (audit)
        await insertAudit(tx, audit, {
          action: "APPROVAL_REQUEST_ADDED",
          entityType: "approval_request",
          entityId: request.id,
          clubId: event.clubId,
          eventId,
          after: { type: input.type, title: input.title, units: input.resources.length },
        });
      await queueNotification(tx, {
        kind: "APPROVAL_REQUESTED",
        recipientUserId: assigneeId,
        eventId,
        approvalRequestId: request.id,
        subject: `${event.title}: approval requested`,
        body: `${auth.user.fullName} asked you to approve "${input.title}" for ${event.title}.`,
      });
      return { request, event: updatedEvent };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "This bundle already contains that request type.");
    throw err;
  }
}

/** Replace the units/window on a pending resource request (releases old holds). */
export async function attachResources(
  auth: AuthContext,
  requestId: string,
  input: z.infer<typeof attachResourcesSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .for("update");
    if (!locked) throw new ApiError("NOT_FOUND", "Approval request not found.");
    const ctx = await requestContext(tx, requestId);
    if (!isClubCoordinator(auth, ctx.event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's coordinators can change its approval requests.",
      );
    if (locked.type !== "RESOURCE_USE")
      throw new ApiError("VALIDATION_ERROR", "Only RESOURCE_USE requests hold resources.");
    if (locked.status !== "PENDING" && locked.status !== "CHANGES_REQUESTED")
      throw new ApiError("CONFLICT", "Resources can only change on an open request.");
    assertVersion(locked, input.expectedVersion);

    await releaseRequestHolds(tx, requestId, "Replaced by coordinator");
    await tx
      .delete(approvalRequestResources)
      .where(eq(approvalRequestResources.requestId, requestId));
    await holdResources(tx, { requestId, eventId: ctx.event.id, resources: input.resources });

    const [updated] = await tx
      .update(approvalRequests)
      .set({
        version: locked.version + 1,
        status: "PENDING",
        decidedAt: null,
        decidedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, requestId))
      .returning();
    await tx.insert(approvalActions).values({
      requestId,
      actorId: auth.user.id,
      action: "RESUBMIT",
      fromTier: locked.currentTier,
      toTier: locked.currentTier,
      fromStatus: locked.status,
      toStatus: "PENDING",
      comment: "Resource window updated.",
      requestVersion: locked.version,
    });
    if (audit)
      await insertAudit(tx, audit, {
        action: "APPROVAL_RESOURCES_ATTACHED",
        entityType: "approval_request",
        entityId: requestId,
        clubId: ctx.club.id,
        eventId: ctx.event.id,
        after: { units: input.resources.length },
      });
    return updated;
  });
}

/** Approvers a coordinator may ask, scoped to active staff with the right role. */
export async function availableApprovers(auth: AuthContext, tier: ApprovalTier) {
  const { db } = getDb();
  const role = TIER_ROLE[tier];
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      scopeType: roleAssignments.scopeType,
      departmentId: roleAssignments.departmentId,
    })
    .from(roleAssignments)
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(
      and(
        eq(roleAssignments.role, role),
        eq(roleAssignments.isActive, true),
        eq(users.status, "ACTIVE"),
      ),
    )
    .orderBy(users.fullName)
    .limit(env.APPROVER_DIRECTORY_MAX);
  if (tier === "SENIOR" && !hasRole(auth, "ADMIN")) {
    return rows.filter((r) => r.scopeType === "GLOBAL" || r.departmentId !== null);
  }
  return rows;
}
