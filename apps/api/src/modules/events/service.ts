import {
  ACTIVE_RESERVATION_STATUSES,
  type EventStatus,
  canTransition,
  changedCriticalFields,
  checkPublishable,
  eligibilityPolicySchema,
  evaluateEligibility,
  summarizeBundle,
  validateBundleComposition,
  validateEventWindow,
} from "@campusops/shared";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import type { z } from "zod";
import { env } from "../../config/env";
import { getDb } from "../../db/client";
import {
  events,
  approvalActions,
  approvalBundles,
  approvalRequestResources,
  approvalRequests,
  clubMemberships,
  clubs,
  eventInvitations,
  eventRevisions,
  files,
  quizzes,
  resourceReservations,
  resourceUnits,
  roleAssignments,
  staffProfiles,
  studentProfiles,
  users,
} from "../../db/schema";
import { type AuthContext, departmentScope, hasRole } from "../../middleware/auth";
import {
  hasEventOversight,
  isClubCoordinator,
  isClubOrganiser,
} from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { isExclusionViolation, isUniqueViolation } from "../../utils/db-error";
import { uniqueSlug } from "../../utils/slug";
import { holdResources, syncEventApprovalState } from "../approvals/service";
import { type AuditContext, insertAudit } from "../audit/service";
import { queueNotification } from "../notifications/outbox";
import type {
  cancelEventSchema,
  completeEventSchema,
  createEventSchema,
  eventListQuerySchema,
  inviteSchema,
  publishEventSchema,
  submitEventSchema,
  updateEventSchema,
} from "./schemas";

type EventRow = typeof events.$inferSelect;

/** Fields captured in an immutable revision snapshot. */
function snapshotOf(event: EventRow) {
  return {
    title: event.title,
    description: event.description,
    template: event.template,
    audience: event.audience,
    admissionMode: event.admissionMode,
    eligibilityPolicy: event.eligibilityPolicy,
    capacity: event.capacity,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    registrationOpensAt: event.registrationOpensAt.toISOString(),
    registrationClosesAt: event.registrationClosesAt.toISOString(),
    venueSummary: event.venueSummary,
    onlineMeetingUrl: event.onlineMeetingUrl,
    jobDescription: event.jobDescription,
    bannerFileId: event.bannerFileId,
    currentRevision: event.currentRevision,
  };
}

async function assertClubCoordinator(auth: AuthContext, clubId: string) {
  const { db } = getDb();
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
  if (!club) throw new ApiError("NOT_FOUND", "Club not found.");
  if (!club.isActive) throw new ApiError("CONFLICT", "This club is not active.");
  if (!isClubCoordinator(auth, clubId))
    throw new ApiError(
      "FORBIDDEN",
      "Only a coordinator of this club can create or change its events.",
    );
  return club;
}

async function assertOwnedBanner(ownerId: string, fileId: string | null | undefined) {
  if (!fileId) return;
  const { db } = getDb();
  const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  if (!file || file.ownerId !== ownerId || file.purpose !== "EVENT_BANNER")
    throw new ApiError("VALIDATION_ERROR", "Banner file not found for this account.");
  if (file.status !== "READY")
    throw new ApiError("VALIDATION_ERROR", "Finish the banner upload before attaching it.");
}

/** Quiz admission only works when a matching quiz is attached. */
const QUIZ_MODE_FOR: Record<string, "TOP_N" | "FIRST_QUALIFIED"> = {
  QUIZ_TOP_N: "TOP_N",
  QUIZ_FIRST_QUALIFIED: "FIRST_QUALIFIED",
};

async function assertQuizReady(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["db"]["transaction"]>[0]>[0],
  event: { id: string; admissionMode: string },
  action: string,
) {
  const expected = QUIZ_MODE_FOR[event.admissionMode];
  if (!expected) return;
  const [quiz] = await tx
    .select({ mode: quizzes.mode })
    .from(quizzes)
    .where(eq(quizzes.eventId, event.id))
    .limit(1);
  if (!quiz)
    throw new ApiError(
      "QUIZ_REQUIRED",
      `This event uses ${event.admissionMode} admission but has no quiz. Attach the quiz before you ${action}.`,
    );
  if (quiz.mode !== expected)
    throw new ApiError(
      "QUIZ_MODE_MISMATCH",
      `The attached quiz is ${quiz.mode}, but the event uses ${event.admissionMode}. Make them match before you ${action}.`,
    );
}

export async function createEvent(
  auth: AuthContext,
  input: z.infer<typeof createEventSchema>,
  audit?: AuditContext,
) {
  const club = await assertClubCoordinator(auth, input.clubId);
  const problems = validateEventWindow(input);
  if (problems.length > 0)
    throw new ApiError("EVENT_WINDOW_INVALID", problems.join(" "), { problems });
  // A quiz-mode draft is allowed: the quiz is attached from the event workspace
  // before submission, and submit/publish refuse the event if it is still missing.
  await assertOwnedBanner(auth.user.id, input.bannerFileId);
  const { db } = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [event] = await tx
        .insert(events)
        .values({
          clubId: input.clubId,
          createdBy: auth.user.id,
          title: input.title,
          slug: uniqueSlug(input.title),
          description: input.description,
          template: input.template,
          audience: input.audience,
          admissionMode: input.admissionMode,
          eligibilityPolicy: input.eligibilityPolicy,
          capacity: input.capacity,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          registrationOpensAt: new Date(input.registrationOpensAt),
          registrationClosesAt: new Date(input.registrationClosesAt),
          venueSummary: input.venueSummary ?? null,
          onlineMeetingUrl: input.onlineMeetingUrl ?? null,
          jobDescription: input.jobDescription ?? null,
          bannerFileId: input.bannerFileId ?? null,
          status: "DRAFT",
          currentRevision: 1,
        })
        .returning();
      if (!event) throw new ApiError("INTERNAL_ERROR", "Event creation failed.");
      await tx.insert(eventRevisions).values({
        eventId: event.id,
        revision: 1,
        snapshot: snapshotOf(event),
        changedFields: [],
        note: "Initial draft.",
        createdBy: auth.user.id,
      });
      if (audit)
        await insertAudit(tx, audit, {
          action: "EVENT_CREATED",
          entityType: "event",
          entityId: event.id,
          clubId: club.id,
          eventId: event.id,
          after: { title: event.title, audience: event.audience, capacity: event.capacity },
        });
      return event;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError("CONFLICT", "Event slug collision. Retry.");
    throw err;
  }
}

export async function updateEvent(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof updateEventSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    if (event.status !== "DRAFT")
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        "A submitted event is frozen. Use /revisions to create a new draft revision.",
      );
    if (event.currentRevision !== input.expectedRevision)
      throw new ApiError("CONFLICT", "The event changed since you opened it. Reload and retry.", {
        currentRevision: event.currentRevision,
      });

    const merged = {
      startsAt: input.startsAt ?? event.startsAt,
      endsAt: input.endsAt ?? event.endsAt,
      registrationOpensAt: input.registrationOpensAt ?? event.registrationOpensAt,
      registrationClosesAt: input.registrationClosesAt ?? event.registrationClosesAt,
    };
    const problems = validateEventWindow(merged);
    if (problems.length > 0)
      throw new ApiError("EVENT_WINDOW_INVALID", problems.join(" "), { problems });
    const [linkedQuiz] = await tx
      .select({ mode: quizzes.mode })
      .from(quizzes)
      .where(eq(quizzes.eventId, eventId))
      .limit(1);
    const nextAdmission = input.admissionMode ?? event.admissionMode;
    const expectedQuizMode = QUIZ_MODE_FOR[nextAdmission];
    if (expectedQuizMode && linkedQuiz && linkedQuiz.mode !== expectedQuizMode)
      throw new ApiError(
        "QUIZ_MODE_MISMATCH",
        `The attached quiz is ${linkedQuiz.mode}; ${nextAdmission} needs ${expectedQuizMode}.`,
      );
    if (input.bannerFileId !== undefined) await assertOwnedBanner(auth.user.id, input.bannerFileId);

    const changed = changedCriticalFields(
      snapshotOf(event) as unknown as Record<string, unknown>,
      input as Record<string, unknown>,
    );
    const [updated] = await tx
      .update(events)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
        ...(input.audience !== undefined ? { audience: input.audience } : {}),
        ...(input.admissionMode !== undefined ? { admissionMode: input.admissionMode } : {}),
        ...(input.eligibilityPolicy !== undefined
          ? { eligibilityPolicy: input.eligibilityPolicy }
          : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.startsAt !== undefined ? { startsAt: new Date(input.startsAt) } : {}),
        ...(input.endsAt !== undefined ? { endsAt: new Date(input.endsAt) } : {}),
        ...(input.registrationOpensAt !== undefined
          ? { registrationOpensAt: new Date(input.registrationOpensAt) }
          : {}),
        ...(input.registrationClosesAt !== undefined
          ? { registrationClosesAt: new Date(input.registrationClosesAt) }
          : {}),
        ...(input.venueSummary !== undefined ? { venueSummary: input.venueSummary ?? null } : {}),
        ...(input.onlineMeetingUrl !== undefined
          ? { onlineMeetingUrl: input.onlineMeetingUrl ?? null }
          : {}),
        ...(input.jobDescription !== undefined
          ? { jobDescription: input.jobDescription ?? null }
          : {}),
        ...(input.bannerFileId !== undefined ? { bannerFileId: input.bannerFileId ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();
    if (!updated) throw new ApiError("INTERNAL_ERROR", "Event update failed.");

    // The draft revision snapshot always mirrors the current draft.
    await tx
      .update(eventRevisions)
      .set({ snapshot: snapshotOf(updated), changedFields: changed })
      .where(
        and(
          eq(eventRevisions.eventId, eventId),
          eq(eventRevisions.revision, event.currentRevision),
        ),
      );
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_UPDATED",
        entityType: "event",
        entityId: eventId,
        clubId: event.clubId,
        eventId,
        before: { title: event.title, capacity: event.capacity, audience: event.audience },
        after: { changedFields: changed },
      });
    return updated;
  });
}

/**
 * Submit freezes the current revision and creates one bundle with individual
 * requests plus resource holds — all in a single transaction.
 */
export async function submitEvent(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof submitEventSchema>,
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
      if (event.status !== "DRAFT")
        throw new ApiError("INVALID_STATE_TRANSITION", "Only a draft event can be submitted.");
      if (event.currentRevision !== input.expectedRevision)
        throw new ApiError("CONFLICT", "The event changed since you opened it. Reload and retry.");
      const problems = validateEventWindow({
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        registrationOpensAt: event.registrationOpensAt,
        registrationClosesAt: event.registrationClosesAt,
      });
      if (problems.length > 0)
        throw new ApiError("EVENT_WINDOW_INVALID", problems.join(" "), { problems });

      await assertQuizReady(tx, event, "submit it");

      const compositionProblems = validateBundleComposition(input.requests, event.audience);
      if (compositionProblems.length > 0)
        throw new ApiError("VALIDATION_ERROR", compositionProblems.join(" "), {
          problems: compositionProblems,
        });

      const [club] = await tx.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);

      // Validate every named approver before writing anything.
      for (const request of input.requests) {
        if (request.type === "RESOURCE_USE" && request.resources.length === 0)
          throw new ApiError("VALIDATION_ERROR", `"${request.title}" must name at least one unit.`);
        if (request.type !== "RESOURCE_USE" && request.resources.length > 0)
          throw new ApiError(
            "VALIDATION_ERROR",
            "Only RESOURCE_USE requests can hold resource units.",
          );
        if (!request.assignedApproverId)
          throw new ApiError(
            "VALIDATION_ERROR",
            `"${request.title}" must name the faculty member who should decide it.`,
          );
        const [approver] = await tx
          .select({ user: users })
          .from(users)
          .where(and(eq(users.id, request.assignedApproverId), eq(users.status, "ACTIVE")))
          .limit(1);
        if (!approver)
          throw new ApiError("APPROVER_UNAVAILABLE", "A named approver is not active.");
        const [facultyRole] = await tx
          .select()
          .from(roleAssignments)
          .where(
            and(
              eq(roleAssignments.userId, request.assignedApproverId),
              eq(roleAssignments.role, "FACULTY"),
              eq(roleAssignments.isActive, true),
            ),
          )
          .limit(1);
        if (!facultyRole)
          throw new ApiError(
            "APPROVER_UNAVAILABLE",
            "The initial approver must hold the FACULTY role.",
          );
        for (const resource of request.resources) {
          const start = new Date(resource.startsAt);
          const end = new Date(resource.endsAt);
          if (start < event.startsAt || end > event.endsAt)
            throw new ApiError(
              "VALIDATION_ERROR",
              "Resource windows must fall inside the event window (including setup time).",
            );
        }
      }

      // Supersede any prior bundle and release its holds.
      const priorBundles = await tx
        .select()
        .from(approvalBundles)
        .where(and(eq(approvalBundles.eventId, eventId), isNull(approvalBundles.supersededAt)));
      for (const prior of priorBundles) {
        const priorRequests = await tx
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.bundleId, prior.id));
        for (const priorRequest of priorRequests) {
          await tx
            .update(resourceReservations)
            .set({
              status: "RELEASED",
              releasedAt: new Date(),
              releaseReason: "Superseded by a new event revision.",
            })
            .where(
              and(
                eq(resourceReservations.requestId, priorRequest.id),
                inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
              ),
            );
        }
        await tx
          .update(approvalBundles)
          .set({ supersededAt: new Date() })
          .where(eq(approvalBundles.id, prior.id));
      }

      const [revision] = await tx
        .insert(eventRevisions)
        .values({
          eventId,
          revision: event.currentRevision,
          snapshot: snapshotOf(event),
          changedFields: [],
          note: input.note ?? "Submitted for approval.",
          createdBy: auth.user.id,
        })
        .onConflictDoUpdate({
          target: [eventRevisions.eventId, eventRevisions.revision],
          set: { snapshot: snapshotOf(event), note: input.note ?? "Submitted for approval." },
        })
        .returning();
      if (!revision) throw new ApiError("INTERNAL_ERROR", "Revision creation failed.");

      const [bundle] = await tx
        .insert(approvalBundles)
        .values({
          eventId,
          eventRevisionId: revision.id,
          submittedBy: auth.user.id,
        })
        .returning();
      if (!bundle) throw new ApiError("INTERNAL_ERROR", "Bundle creation failed.");

      const createdRequests: Array<typeof approvalRequests.$inferSelect> = [];
      for (const request of input.requests) {
        const [row] = await tx
          .insert(approvalRequests)
          .values({
            bundleId: bundle.id,
            type: request.type,
            title: request.title,
            description: request.description ?? null,
            isRequired: request.isRequired,
            currentTier: "FACULTY",
            assignedApproverId: request.assignedApproverId ?? null,
            createdBy: auth.user.id,
            dueAt: request.dueAt ? new Date(request.dueAt) : null,
          })
          .returning();
        if (!row) throw new ApiError("INTERNAL_ERROR", "Approval request creation failed.");
        await holdResources(tx, {
          requestId: row.id,
          eventId,
          resources: request.resources,
        });
        await tx.insert(approvalActions).values({
          requestId: row.id,
          actorId: auth.user.id,
          action: "SUBMIT",
          toTier: "FACULTY",
          toStatus: "PENDING",
          requestVersion: 1,
        });
        createdRequests.push(row);
      }

      const [updatedEvent] = await tx
        .update(events)
        .set({ status: "PENDING_APPROVALS", submittedAt: new Date(), updatedAt: new Date() })
        .where(eq(events.id, eventId))
        .returning();

      if (audit)
        await insertAudit(tx, audit, {
          action: "EVENT_SUBMITTED",
          entityType: "event",
          entityId: eventId,
          clubId: event.clubId,
          eventId,
          before: { status: event.status, revision: event.currentRevision },
          after: {
            status: "PENDING_APPROVALS",
            revision: event.currentRevision,
            requests: createdRequests.length,
          },
        });

      for (const request of createdRequests) {
        await queueNotification(tx, {
          kind: "APPROVAL_REQUESTED",
          recipientUserId: request.assignedApproverId,
          eventId,
          approvalRequestId: request.id,
          subject: `${event.title}: approval requested`,
          body: `${auth.user.fullName} asked you to approve "${request.title}" for ${event.title}.`,
          payload: { clubId: club?.id, requestType: request.type },
        });
      }

      return {
        event: updatedEvent,
        bundle,
        requests: createdRequests,
        summary: summarizeBundle(createdRequests),
      };
    });
  } catch (err) {
    if (isExclusionViolation(err))
      throw new ApiError(
        "RESOURCE_CONFLICT",
        "A requested resource is already held or confirmed for that window.",
      );
    if (isUniqueViolation(err))
      throw new ApiError("CONFLICT", "Duplicate approval request type in this submission.");
    throw err;
  }
}

/**
 * Critical change after submission: create a new draft revision, keep history.
 * Existing approvals stay attached to the old revision until re-submission.
 */
export async function createRevision(
  auth: AuthContext,
  eventId: string,
  input: { expectedRevision: number; note?: string | undefined },
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    if (event.status === "COMPLETED" || event.status === "CANCELLED")
      throw new ApiError("INVALID_STATE_TRANSITION", "This event is closed.");
    if (event.status === "DRAFT")
      throw new ApiError("CONFLICT", "The event is already a draft. Edit it directly.");
    if (event.currentRevision !== input.expectedRevision)
      throw new ApiError("CONFLICT", "The event changed since you opened it. Reload and retry.");

    // A revision starts a fresh approval cycle. Retire the open bundle and
    // release anything it was holding so the new submission is not blocked by
    // stale reservations from the previous attempt.
    const priorBundles = await tx
      .select()
      .from(approvalBundles)
      .where(and(eq(approvalBundles.eventId, eventId), isNull(approvalBundles.supersededAt)));
    for (const prior of priorBundles) {
      const priorRequests = await tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.bundleId, prior.id));
      if (priorRequests.length)
        await tx
          .update(resourceReservations)
          .set({
            status: "RELEASED",
            releasedAt: new Date(),
            releaseReason: "Superseded by a new event revision.",
          })
          .where(
            and(
              inArray(
                resourceReservations.requestId,
                priorRequests.map((r) => r.id),
              ),
              inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
            ),
          );
      await tx
        .update(approvalBundles)
        .set({ supersededAt: new Date() })
        .where(eq(approvalBundles.id, prior.id));
    }

    const nextRevision = event.currentRevision + 1;
    const [updated] = await tx
      .update(events)
      .set({
        status: "DRAFT",
        currentRevision: nextRevision,
        readyAt: null,
        submittedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();
    if (!updated) throw new ApiError("INTERNAL_ERROR", "Revision creation failed.");
    await tx.insert(eventRevisions).values({
      eventId,
      revision: nextRevision,
      snapshot: snapshotOf(updated),
      changedFields: [],
      note: input.note ?? "New draft revision.",
      createdBy: auth.user.id,
    });
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_REVISION_CREATED",
        entityType: "event",
        entityId: eventId,
        clubId: event.clubId,
        eventId,
        before: { status: event.status, revision: event.currentRevision },
        after: { status: "DRAFT", revision: nextRevision },
      });
    return updated;
  });
}

export async function publishEvent(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof publishEventSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    if (event.currentRevision !== input.expectedRevision)
      throw new ApiError("CONFLICT", "The event changed since you opened it. Reload and retry.");

    await assertQuizReady(tx, event, "publish it");

    const [bundle] = await tx
      .select()
      .from(approvalBundles)
      .where(and(eq(approvalBundles.eventId, eventId), isNull(approvalBundles.supersededAt)))
      .limit(1);
    const requests = bundle
      ? await tx.select().from(approvalRequests).where(eq(approvalRequests.bundleId, bundle.id))
      : [];
    const summary = summarizeBundle(requests);

    // Every approved resource request must still own a live reservation.
    const resourceRequestIds = requests
      .filter((r) => r.type === "RESOURCE_USE" && r.status === "APPROVED" && r.isRequired)
      .map((r) => r.id);
    let holdsValid = true;
    if (resourceRequestIds.length > 0) {
      const reservations = await tx
        .select()
        .from(resourceReservations)
        .where(inArray(resourceReservations.requestId, resourceRequestIds));
      const now = new Date();
      for (const requestId of resourceRequestIds) {
        const own = reservations.filter((r) => r.requestId === requestId);
        const live = own.filter(
          (r) =>
            r.status === "CONFIRMED" ||
            (r.status === "HELD" && (!r.holdExpiresAt || r.holdExpiresAt > now)),
        );
        if (own.length === 0 || live.length !== own.length) holdsValid = false;
      }
    }

    const check = checkPublishable({
      status: event.status,
      requiredApprovalsReady: summary.readyToPublish,
      hasRequiredApprovals: summary.required > 0,
      resourceHoldsValid: holdsValid,
      registrationClosesAt: event.registrationClosesAt,
    });
    if (!check.allowed)
      throw new ApiError(
        (check.code ?? "CONFLICT") as "CONFLICT",
        check.message ?? "Event cannot be published.",
        {
          blockingRequestIds: summary.blockingRequestIds,
          failedRequestIds: summary.failedRequestIds,
        },
      );
    if (!canTransition(event.status, "PUBLISHED"))
      throw new ApiError("INVALID_STATE_TRANSITION", `Cannot publish from ${event.status}.`);

    const [updated] = await tx
      .update(events)
      .set({ status: "PUBLISHED", publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(events.id, eventId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_PUBLISHED",
        entityType: "event",
        entityId: eventId,
        clubId: event.clubId,
        eventId,
        before: { status: event.status },
        after: { status: "PUBLISHED", revision: event.currentRevision },
      });
    return { event: updated, summary };
  });
}

export async function cancelEvent(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof cancelEventSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    // Cancellation changes the event and releases its holds, so it stays with
    // the club's coordinators. Oversight decides approvals instead.
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can cancel it. Oversight can review and decide approvals.",
      );
    if (!canTransition(event.status, "CANCELLED"))
      throw new ApiError("INVALID_STATE_TRANSITION", `Cannot cancel from ${event.status}.`);

    // Release every active reservation for the event.
    await tx
      .update(resourceReservations)
      .set({
        status: "RELEASED",
        releasedAt: new Date(),
        releaseReason: `Event cancelled: ${input.reason}`.slice(0, 500),
      })
      .where(
        and(
          eq(resourceReservations.eventId, eventId),
          inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
        ),
      );
    // Cancel still-open approval requests so approver inboxes stay clean.
    await assertQuizReady(tx, event, "publish it");

    const [bundle] = await tx
      .select()
      .from(approvalBundles)
      .where(and(eq(approvalBundles.eventId, eventId), isNull(approvalBundles.supersededAt)))
      .limit(1);
    if (bundle) {
      const pending = await tx
        .select()
        .from(approvalRequests)
        .where(
          and(eq(approvalRequests.bundleId, bundle.id), eq(approvalRequests.status, "PENDING")),
        );
      for (const request of pending) {
        await tx
          .update(approvalRequests)
          .set({ status: "CANCELLED", version: request.version + 1, updatedAt: new Date() })
          .where(eq(approvalRequests.id, request.id));
        await tx.insert(approvalActions).values({
          requestId: request.id,
          actorId: auth.user.id,
          action: "CANCEL",
          fromTier: request.currentTier,
          toTier: request.currentTier,
          fromStatus: "PENDING",
          toStatus: "CANCELLED",
          comment: `Event cancelled: ${input.reason}`.slice(0, 4000),
          requestVersion: request.version,
        });
      }
    }

    const [updated] = await tx
      .update(events)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason: input.reason,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_CANCELLED",
        entityType: "event",
        entityId: eventId,
        clubId: event.clubId,
        eventId,
        before: { status: event.status },
        after: { status: "CANCELLED", reason: input.reason },
      });
    return updated;
  });
}

export async function startEvent(auth: AuthContext, eventId: string, audit?: AuditContext) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    if (!canTransition(event.status, "LIVE"))
      throw new ApiError("INVALID_STATE_TRANSITION", `Cannot start from ${event.status}.`);
    const [updated] = await tx
      .update(events)
      .set({ status: "LIVE", updatedAt: new Date() })
      .where(eq(events.id, eventId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_STARTED",
        entityType: "event",
        entityId: eventId,
        clubId: event.clubId,
        eventId,
        before: { status: event.status },
        after: { status: "LIVE" },
      });
    return updated;
  });
}

export async function completeEvent(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof completeEventSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    if (event.status !== "LIVE" && event.status !== "PUBLISHED")
      throw new ApiError("INVALID_STATE_TRANSITION", `Cannot complete from ${event.status}.`);
    if (event.endsAt > new Date())
      throw new ApiError("CONFLICT", "The event has not finished yet.");
    await tx
      .update(resourceReservations)
      .set({
        status: "RELEASED",
        releasedAt: new Date(),
        releaseReason: "Event completed.",
      })
      .where(
        and(
          eq(resourceReservations.eventId, eventId),
          inArray(resourceReservations.status, [...ACTIVE_RESERVATION_STATUSES]),
        ),
      );
    const [updated] = await tx
      .update(events)
      .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(events.id, eventId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_COMPLETED",
        entityType: "event",
        entityId: eventId,
        clubId: event.clubId,
        eventId,
        before: { status: event.status },
        after: { status: "COMPLETED" },
      });
    return updated;
  });
}

export async function listRevisions(auth: AuthContext, eventId: string) {
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  const [club] = await db.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);
  const allowed =
    isClubCoordinator(auth, event.clubId) ||
    hasEventOversight(auth, club?.departmentId ?? null) ||
    hasRole(auth, "FACULTY");
  if (!allowed) throw new ApiError("NOT_FOUND", "Event not found.");
  return db
    .select({
      revision: eventRevisions,
      createdBy: { id: users.id, fullName: users.fullName },
    })
    .from(eventRevisions)
    .innerJoin(users, eq(users.id, eventRevisions.createdBy))
    .where(eq(eventRevisions.eventId, eventId))
    .orderBy(desc(eventRevisions.revision));
}

export async function eligibilityPreview(auth: AuthContext, eventId: string) {
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  const [student] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, auth.user.id))
    .limit(1);
  const [staff] = await db
    .select()
    .from(staffProfiles)
    .where(eq(staffProfiles.userId, auth.user.id))
    .limit(1);
  const [invite] = await db
    .select()
    .from(eventInvitations)
    .where(
      and(
        eq(eventInvitations.eventId, eventId),
        eq(eventInvitations.email, auth.user.email),
        isNull(eventInvitations.revokedAt),
      ),
    )
    .limit(1);
  const hasInvitation = Boolean(
    invite && (!invite.expiresAt || invite.expiresAt.getTime() > Date.now()),
  );
  const policy = eligibilityPolicySchema.parse(event.eligibilityPolicy);
  const result = evaluateEligibility(policy, {
    accountType: auth.user.accountType,
    departmentId: student?.departmentId ?? staff?.departmentId ?? null,
    graduationYear: student?.graduationYear ?? null,
    hasInvitation,
  });
  const now = Date.now();
  const registrationOpen =
    event.registrationOpensAt.getTime() <= now && event.registrationClosesAt.getTime() >= now;
  return {
    eventId,
    ...result,
    accountStatus: auth.user.status,
    registrationOpen,
    admissionMode: event.admissionMode,
    canApply:
      result.eligible &&
      auth.user.status === "ACTIVE" &&
      registrationOpen &&
      (event.status === "PUBLISHED" || event.status === "LIVE"),
  };
}

export async function invite(
  auth: AuthContext,
  eventId: string,
  input: z.infer<typeof inviteSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    if (event.status === "CANCELLED" || event.status === "COMPLETED")
      throw new ApiError("CONFLICT", "This event is closed.");
    if (input.expiresAt && new Date(input.expiresAt) <= new Date())
      throw new ApiError("VALIDATION_ERROR", "Invitation expiry must be in the future.");

    const emails = [...new Set(input.emails.map((e) => e.toLowerCase()))];
    const matched = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.email, emails));
    const byEmail = new Map(matched.map((u) => [u.email, u.id]));
    const rows = await tx
      .insert(eventInvitations)
      .values(
        emails.map((email) => ({
          eventId,
          email,
          userId: byEmail.get(email) ?? null,
          invitedBy: auth.user.id,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })),
      )
      .onConflictDoUpdate({
        target: [eventInvitations.eventId, eventInvitations.email],
        set: {
          revokedAt: null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          invitedBy: auth.user.id,
        },
      })
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_INVITATIONS_CREATED",
        entityType: "event",
        entityId: eventId,
        clubId: event.clubId,
        eventId,
        after: { count: rows.length },
      });
    for (const row of rows) {
      if (row.userId) {
        await queueNotification(tx, {
          kind: "EVENT_INVITATION",
          recipientUserId: row.userId,
          eventId,
          subject: `You are invited: ${event.title}`,
          body: `You have been invited to ${event.title}. Open CampusOps to view the event.`,
        });
      }
    }
    return { items: rows, invited: rows.length };
  });
}

export async function listInvitations(auth: AuthContext, eventId: string) {
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  const [club] = await db.select().from(clubs).where(eq(clubs.id, event.clubId)).limit(1);
  const canRead =
    isClubCoordinator(auth, event.clubId) ||
    isClubOrganiser(auth, event.clubId) ||
    hasEventOversight(auth, club?.departmentId ?? null);
  if (!canRead) throw new ApiError("NOT_FOUND", "Event not found.");
  return db
    .select()
    .from(eventInvitations)
    .where(eq(eventInvitations.eventId, eventId))
    .orderBy(desc(eventInvitations.createdAt))
    .limit(env.INVITATION_LIST_MAX);
}

export async function revokeInvitation(
  auth: AuthContext,
  eventId: string,
  inviteId: string,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (!isClubCoordinator(auth, event.clubId))
      throw new ApiError(
        "FORBIDDEN",
        "Only this event's club coordinators can change it. Oversight can review and decide approvals.",
      );
    const [row] = await tx
      .update(eventInvitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(eventInvitations.id, inviteId), eq(eventInvitations.eventId, eventId)))
      .returning();
    if (!row) throw new ApiError("NOT_FOUND", "Invitation not found.");
    if (audit)
      await insertAudit(tx, audit, {
        action: "EVENT_INVITATION_REVOKED",
        entityType: "event_invitation",
        entityId: inviteId,
        clubId: event.clubId,
        eventId,
      });
    return row;
  });
}

/** Club event list with operational filters, scoped by membership. */
export async function listClubEventsScoped(
  clubId: string,
  input: z.infer<typeof eventListQuerySchema>,
) {
  const { db } = getDb();
  const filters: SQL[] = [eq(events.clubId, clubId)];
  if (input.status) filters.push(eq(events.status, input.status));
  if (input.q) filters.push(ilike(events.title, `%${input.q}%`));
  if (input.from) filters.push(gte(events.startsAt, new Date(input.from)));
  if (input.to) filters.push(lte(events.startsAt, new Date(input.to)));
  const where = and(...filters);
  const rows = await db
    .select()
    .from(events)
    .where(where)
    .orderBy(desc(events.startsAt), asc(events.id))
    .limit(input.limit + 1)
    .offset(input.offset);
  const [totalRow] = await db.select({ n: count() }).from(events).where(where);
  return {
    items: rows.slice(0, input.limit),
    total: totalRow?.n ?? 0,
    limit: input.limit,
    offset: input.offset,
    hasMore: rows.length > input.limit,
  };
}

/** Coordinator's own workload across clubs. */
export async function myManagedEvents(
  auth: AuthContext,
  input: Partial<z.infer<typeof eventListQuerySchema>> = {},
) {
  const { db } = getDb();
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const admin = hasRole(auth, "ADMIN");
  const senior = departmentScope(auth, "HOD_DEAN");
  const filters: SQL[] = [];
  if (!admin && !senior.global) {
    // Admin sees the institution; an HOD/Dean sees their department's clubs.
    // Club leads and coordinators keep their own clubs either way.
    const scopedClubIds = new Set(auth.memberships.map((m) => m.clubId));
    if (senior.departmentIds.length) {
      const deptClubs = await db
        .select({ id: clubs.id })
        .from(clubs)
        .where(inArray(clubs.departmentId, senior.departmentIds));
      for (const club of deptClubs) scopedClubIds.add(club.id);
    }
    if (scopedClubIds.size === 0) return { items: [], total: 0, limit, offset, hasMore: false };
    filters.push(inArray(events.clubId, [...scopedClubIds]));
  }
  if (input.status) filters.push(eq(events.status, input.status));
  if (input.q) filters.push(ilike(events.title, `%${input.q}%`));
  const where = and(...filters);
  const rows = await db
    .select()
    .from(events)
    .where(where)
    .orderBy(desc(events.createdAt))
    .limit(limit + 1)
    .offset(offset);
  const [totalRow] = await db.select({ n: count() }).from(events).where(where);
  return {
    items: rows.slice(0, limit),
    total: totalRow?.n ?? 0,
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}
