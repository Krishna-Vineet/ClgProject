import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql, count as sqlCount } from "drizzle-orm";
import { env } from "../../config/env";
import { type DbClient, getDb } from "../../db/client";
import {
  events,
  announcements,
  approvalActions,
  approvalBundles,
  approvalRequests,
  checkpoints,
  clubMemberships,
  clubs,
  complaintLocations,
  complaints,
  departments,
  eventReports,
  files,
  passes,
  quizAttempts,
  quizQuestions,
  quizzes,
  redemptions,
  registrations,
  resourceReservations,
  resourceUnits,
  resources,
  scanLogs,
  users,
} from "../../db/schema";
import { type AuthContext, hasRole } from "../../middleware/auth";
import { hasEventOversight, isClubCoordinator, isClubFaculty } from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { canArchiveReports, deleteReportObject, putReportObject } from "../storage/service";
import { renderReportPdf } from "./pdf";

type Tx = Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0];

export type ReportAttendee = {
  userId: string;
  fullName: string;
  email: string;
  accountType: string;
  rollNumber: string | null;
  department: string | null;
  departmentCode: string | null;
  registrationStatus: string;
  admittedBy: string;
  checkedInAt: string | null;
};

export type EventReportSnapshot = {
  /** 2 adds the Phase 7 on-the-day sections; 1 reports remain readable. */
  reportVersion: 1 | 2;
  generatedAt: string;
  generatedBy: { id: string; fullName: string; email: string };
  institution: { timezone: string };
  event: {
    id: string;
    title: string;
    slug: string;
    template: string;
    status: string;
    description: string;
    audience: string;
    admissionMode: string;
    capacity: number;
    venueSummary: string | null;
    onlineMeetingUrl: string | null;
    jobDescription: string | null;
    startsAt: string;
    endsAt: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
    publishedAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    cancellationReason: string | null;
    revision: number;
  };
  club: { id: string; name: string; department: string | null };
  organizers: Array<{ id: string; fullName: string; email: string; clubRole: string }>;
  clubFaculty: Array<{ id: string; fullName: string; email: string }>;
  /** Legacy field: reports filed before club faculty replaced the advisor role. */
  facultyAdvisor?: { id: string; fullName: string; email: string } | null;
  approvals: Array<{
    requestId: string;
    type: string;
    title: string;
    isRequired: boolean;
    finalStatus: string;
    finalTier: string;
    decidedBy: { id: string; fullName: string } | null;
    decidedAt: string | null;
    trail: Array<{
      action: string;
      actor: string;
      fromTier: string | null;
      toTier: string | null;
      comment: string | null;
      at: string;
    }>;
  }>;
  facultyInvolved: Array<{ id: string; fullName: string; email: string; role: string }>;
  resourcesUsed: Array<{
    resource: string;
    unit: string;
    startsAt: string;
    endsAt: string;
    status: string;
  }>;
  attendance: {
    registered: number;
    confirmed: number;
    waitlisted: number;
    cancelled: number;
    rejected: number;
    checkedIn: number;
    capacity: number;
    fillRatePercent: number | null;
    attendanceRatePercent: number | null;
    source: "QR_SCAN" | "REGISTRATION_ONLY";
  };
  attendees: ReportAttendee[];
  /** True when the attendee list was capped; counts above remain exact. */
  attendeesTruncated: boolean;
  /** Phase 7: what actually happened on the day, per QR counter. */
  access: {
    counters: Array<{
      id: string;
      name: string;
      qrType: string;
      maxUses: number | null;
      granted: number;
      denied: number;
      uniqueParticipants: number;
      offlineSynced: number;
      identityMismatches: number;
    }>;
    totalGranted: number;
    totalDenied: number;
    offlineSynced: number;
    denialReasons: Array<{ reason: string; count: number }>;
    identityChecks: { match: number; mismatch: number; notRequired: number };
  };
  /** Issues raised by participants during the event. */
  issues: {
    total: number;
    open: number;
    resolved: number;
    byCategory: Array<{ category: string; count: number }>;
    byLocation: Array<{ location: string; count: number }>;
  };
  /** Present only when the event used quiz admission. */
  quiz: {
    mode: string;
    status: string;
    passScore: number | null;
    seats: number;
    questionCount: number;
    attempts: number;
    submitted: number;
    expired: number;
    qualified: number;
    averagePercent: number | null;
    highestPercent: number | null;
    allocatedAt: string | null;
    confirmed: number;
    waitlisted: number;
  } | null;
  /** Announcements the organisers published for this event. */
  announcements: Array<{
    title: string;
    audience: string;
    publishedAt: string;
    revoked: boolean;
  }>;
  notes: string | null;
  integrity: { algorithm: "sha256"; checksum: string };
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Report access is institutional: the coordinators who ran the event, the faculty
 * who were involved in approving it, HOD/Dean within the department, and Admin.
 * A random faculty member who never touched the event cannot pull its attendee list.
 */
export async function assertReportAccess(auth: AuthContext, eventId: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ event: events, club: clubs })
    .from(events)
    .innerJoin(clubs, eq(clubs.id, events.clubId))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Event not found.");

  const coordinator = isClubCoordinator(auth, row.event.clubId);
  const oversight = hasEventOversight(auth, row.club.departmentId);
  // Club faculty organise the club's events, so they read its reports.
  const clubFaculty = isClubFaculty(auth, row.event.clubId);

  // Faculty who actually acted on this event's approvals are "involved".
  let involved = false;
  if (!coordinator && !oversight && !clubFaculty && hasRole(auth, "FACULTY")) {
    const [acted] = await db
      .select({ id: approvalActions.id })
      .from(approvalActions)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalActions.requestId))
      .innerJoin(approvalBundles, eq(approvalBundles.id, approvalRequests.bundleId))
      .where(and(eq(approvalBundles.eventId, eventId), eq(approvalActions.actorId, auth.user.id)))
      .limit(1);
    involved = Boolean(acted);
  }

  if (!coordinator && !oversight && !clubFaculty && !involved)
    throw new ApiError("NOT_FOUND", "Event not found.");
  return row;
}

/** Assemble the full record. Reads only; never mutates. */
export async function buildSnapshot(
  auth: AuthContext,
  eventId: string,
  notes?: string | null,
): Promise<Omit<EventReportSnapshot, "integrity">> {
  const { db } = getDb();
  const { event, club } = await assertReportAccess(auth, eventId);

  const [dept] = club.departmentId
    ? await db.select().from(departments).where(eq(departments.id, club.departmentId)).limit(1)
    : [];

  const organizerRows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      clubRole: clubMemberships.clubRole,
    })
    .from(clubMemberships)
    .innerJoin(users, eq(users.id, clubMemberships.userId))
    .where(and(eq(clubMemberships.clubId, club.id), eq(clubMemberships.isActive, true)))
    .orderBy(asc(clubMemberships.clubRole), asc(users.fullName));

  // Club faculty come from the membership table; there is no advisor field.
  const clubFacultyRows = organizerRows.filter((o) => o.clubRole === "FACULTY");

  // Every bundle for the event, including superseded ones: the report must show
  // the real approval history, not just the final revision.
  const bundles = await db
    .select()
    .from(approvalBundles)
    .where(eq(approvalBundles.eventId, eventId))
    .orderBy(asc(approvalBundles.createdAt));
  const bundleIds = bundles.map((b) => b.id);

  const requestRows = bundleIds.length
    ? await db
        .select({ request: approvalRequests, decider: { id: users.id, fullName: users.fullName } })
        .from(approvalRequests)
        .leftJoin(users, eq(users.id, approvalRequests.decidedBy))
        .where(inArray(approvalRequests.bundleId, bundleIds))
        .orderBy(asc(approvalRequests.createdAt))
    : [];

  const requestIds = requestRows.map((r) => r.request.id);
  const actionRows = requestIds.length
    ? await db
        .select({ action: approvalActions, actor: { id: users.id, fullName: users.fullName } })
        .from(approvalActions)
        .innerJoin(users, eq(users.id, approvalActions.actorId))
        .where(inArray(approvalActions.requestId, requestIds))
        .orderBy(asc(approvalActions.createdAt), asc(approvalActions.id))
    : [];

  const approvals = requestRows.map(({ request, decider }) => ({
    requestId: request.id,
    type: request.type,
    title: request.title,
    isRequired: request.isRequired,
    finalStatus: request.status,
    finalTier: request.currentTier,
    decidedBy: decider?.id ? decider : null,
    decidedAt: iso(request.decidedAt),
    trail: actionRows
      .filter((a) => a.action.requestId === request.id)
      .map((a) => ({
        action: a.action.action,
        actor: a.actor.fullName,
        fromTier: a.action.fromTier,
        toTier: a.action.toTier,
        comment: a.action.comment,
        at: a.action.createdAt.toISOString(),
      })),
  }));

  // Faculty involved = people who actually decided or escalated a permission,
  // plus the club's faculty members. Submitting a request is the coordinator's own act and
  // must not make a student coordinator appear as "faculty involved".
  const DECISION_ACTIONS = new Set([
    "APPROVE",
    "REJECT",
    "REQUEST_CHANGES",
    "ESCALATE",
    "REASSIGN",
  ]);
  const decisionRows = actionRows.filter((a) => DECISION_ACTIONS.has(a.action.action));
  const facultyMap = new Map<
    string,
    { id: string; fullName: string; email: string; role: string }
  >();
  const actorIds = [...new Set(decisionRows.map((a) => a.actor.id))];
  if (actorIds.length) {
    const actorUsers = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        accountType: users.accountType,
      })
      .from(users)
      .where(inArray(users.id, actorIds));
    for (const u of actorUsers) {
      // Only staff accounts belong in a faculty list, regardless of who acted.
      if (u.accountType !== "STAFF") continue;
      const tiers = [
        ...new Set(
          decisionRows
            .filter((a) => a.actor.id === u.id)
            .map((a) => a.action.toTier ?? a.action.fromTier)
            .filter(Boolean),
        ),
      ];
      facultyMap.set(u.id, {
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        role: tiers.length ? `Approver (${tiers.join(" → ")})` : "Approver",
      });
    }
  }
  for (const f of clubFacultyRows)
    if (!facultyMap.has(f.id))
      facultyMap.set(f.id, {
        id: f.id,
        fullName: f.fullName,
        email: f.email,
        role: "Club faculty",
      });

  const reservationRows = await db
    .select({
      reservation: resourceReservations,
      unit: resourceUnits,
      resource: resources,
    })
    .from(resourceReservations)
    .innerJoin(resourceUnits, eq(resourceUnits.id, resourceReservations.resourceUnitId))
    .innerJoin(resources, eq(resources.id, resourceUnits.resourceId))
    .where(eq(resourceReservations.eventId, eventId))
    .orderBy(asc(resourceReservations.startsAt));

  // Counts come from the database so they stay exact even when the listed rows
  // are capped for a very large event.
  const countRows = await db
    .select({ status: registrations.status, n: sqlCount() })
    .from(registrations)
    .where(eq(registrations.eventId, eventId))
    .groupBy(registrations.status);
  const totals = new Map(countRows.map((r) => [r.status, Number(r.n)]));
  const totalRegistered = countRows.reduce((sum, r) => sum + Number(r.n), 0);

  const registrationRows = await db
    .select({ registration: registrations, user: users })
    .from(registrations)
    .innerJoin(users, eq(users.id, registrations.userId))
    .where(eq(registrations.eventId, eventId))
    .orderBy(asc(registrations.appliedAt))
    .limit(env.REPORT_MAX_ATTENDEES);

  // Attendance comes from redeemed passes (QR check-in). Until the QR phase ships
  // there are no redemptions, so the report says REGISTRATION_ONLY explicitly
  // rather than implying nobody showed up.
  const regIds = registrationRows.map((r) => r.registration.id);
  const passRows = regIds.length
    ? await db.select().from(passes).where(inArray(passes.registrationId, regIds))
    : [];
  const passIds = passRows.map((p) => p.id);
  const redemptionRows = passIds.length
    ? await db.select().from(redemptions).where(inArray(redemptions.passId, passIds))
    : [];
  const checkpointRows = await db
    .select({ id: checkpoints.id })
    .from(checkpoints)
    .where(eq(checkpoints.eventId, eventId));

  // Exact distinct check-in count across the whole event, not just listed rows.
  const [checkInTotal] = await db
    .select({ n: sqlCount(sql`distinct ${passes.registrationId}`) })
    .from(redemptions)
    .innerJoin(passes, eq(passes.id, redemptions.passId))
    .innerJoin(registrations, eq(registrations.id, passes.registrationId))
    .where(eq(registrations.eventId, eventId));
  const totalCheckedIn = Number(checkInTotal?.n ?? 0);

  const firstScanByPass = new Map<string, Date>();
  for (const r of redemptionRows) {
    const existing = firstScanByPass.get(r.passId);
    if (!existing || r.redeemedAt < existing) firstScanByPass.set(r.passId, r.redeemedAt);
  }
  const checkInByRegistration = new Map<string, Date>();
  for (const p of passRows) {
    const at = firstScanByPass.get(p.id);
    if (at) checkInByRegistration.set(p.registrationId, at);
  }

  const { studentProfiles } = await import("../../db/schema");
  const userIds = registrationRows.map((r) => r.user.id);
  const profileRows = userIds.length
    ? await db.select().from(studentProfiles).where(inArray(studentProfiles.userId, userIds))
    : [];
  const deptRows = await db
    .select({ id: departments.id, name: departments.name, code: departments.code })
    .from(departments);
  const deptName = new Map(deptRows.map((d) => [d.id, d.name]));
  const deptCode = new Map(deptRows.map((d) => [d.id, d.code]));

  const attendees: ReportAttendee[] = registrationRows.map(({ registration, user }) => {
    const profile = profileRows.find((p) => p.userId === user.id);
    return {
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      accountType: user.accountType,
      rollNumber: profile?.rollNumber ?? null,
      department: profile?.departmentId ? (deptName.get(profile.departmentId) ?? null) : null,
      departmentCode: profile?.departmentId ? (deptCode.get(profile.departmentId) ?? null) : null,
      registrationStatus: registration.status,
      admittedBy: registration.admissionModeSnapshot,
      checkedInAt: iso(checkInByRegistration.get(registration.id)),
    };
  });

  const count = (status: string) => totals.get(status as never) ?? 0;
  const confirmed = count("CONFIRMED");
  const checkedIn = totalCheckedIn;
  const hasQrInfrastructure = checkpointRows.length > 0;

  const snapshot: Omit<EventReportSnapshot, "integrity"> = {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    generatedBy: { id: auth.user.id, fullName: auth.user.fullName, email: auth.user.email },
    institution: { timezone: env.CAMPUS_TIMEZONE },
    event: {
      id: event.id,
      title: event.title,
      slug: event.slug,
      template: event.template,
      status: event.status,
      description: event.description,
      audience: event.audience,
      admissionMode: event.admissionMode,
      capacity: event.capacity,
      venueSummary: event.venueSummary,
      onlineMeetingUrl: event.onlineMeetingUrl,
      jobDescription: event.jobDescription,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      registrationOpensAt: event.registrationOpensAt.toISOString(),
      registrationClosesAt: event.registrationClosesAt.toISOString(),
      publishedAt: iso(event.publishedAt),
      completedAt: iso(event.completedAt),
      cancelledAt: iso(event.cancelledAt),
      cancellationReason: event.cancellationReason,
      revision: event.currentRevision,
    },
    club: { id: club.id, name: club.name, department: dept?.name ?? null },
    organizers: organizerRows,
    clubFaculty: clubFacultyRows.map((f) => ({ id: f.id, fullName: f.fullName, email: f.email })),
    approvals,
    facultyInvolved: [...facultyMap.values()],
    resourcesUsed: reservationRows.map((r) => ({
      resource: r.resource.name,
      unit: r.unit.label,
      startsAt: r.reservation.startsAt.toISOString(),
      endsAt: r.reservation.endsAt.toISOString(),
      status: r.reservation.status,
    })),
    attendance: {
      registered: totalRegistered,
      confirmed,
      waitlisted: count("WAITLISTED"),
      cancelled: count("CANCELLED"),
      rejected: count("REJECTED"),
      checkedIn,
      capacity: event.capacity,
      fillRatePercent: event.capacity > 0 ? Math.round((confirmed / event.capacity) * 100) : null,
      attendanceRatePercent:
        confirmed > 0 && hasQrInfrastructure ? Math.round((checkedIn / confirmed) * 100) : null,
      source: hasQrInfrastructure ? "QR_SCAN" : "REGISTRATION_ONLY",
    },
    attendees,
    attendeesTruncated: totalRegistered > registrationRows.length,
    access: await buildAccessSection(eventId),
    issues: await buildIssuesSection(eventId),
    quiz: await buildQuizSection(eventId, event.capacity),
    announcements: await buildAnnouncementsSection(eventId),
    notes: notes ?? null,
  };
  return snapshot;
}

/**
 * Phase 7 report sections. Each is computed from the operational tables, never
 * estimated, and each states counts a coordinator can reconcile against the
 * access log and complaint inbox they already saw during the event.
 */
async function buildAccessSection(eventId: string): Promise<EventReportSnapshot["access"]> {
  const { db } = getDb();
  const counters = await db.select().from(checkpoints).where(eq(checkpoints.eventId, eventId));
  const logs = await db
    .select({
      checkpointId: scanLogs.checkpointId,
      result: scanLogs.result,
      reason: scanLogs.reason,
      identityCheck: scanLogs.identityCheck,
      syncedOffline: scanLogs.syncedOffline,
      passId: scanLogs.passId,
    })
    .from(scanLogs)
    .where(eq(scanLogs.eventId, eventId));

  const rows = counters.map((cp) => {
    const mine = logs.filter((l) => l.checkpointId === cp.id);
    const granted = mine.filter((l) => l.result === "GRANTED");
    return {
      id: cp.id,
      name: cp.name,
      qrType: cp.qrType as string,
      maxUses: cp.maxUses,
      granted: granted.length,
      denied: mine.length - granted.length,
      uniqueParticipants: new Set(granted.map((l) => l.passId).filter(Boolean)).size,
      offlineSynced: mine.filter((l) => l.syncedOffline).length,
      identityMismatches: mine.filter((l) => l.identityCheck === "MISMATCH").length,
    };
  });

  const denialMap = new Map<string, number>();
  for (const l of logs.filter((x) => x.result === "DENIED"))
    denialMap.set(l.reason, (denialMap.get(l.reason) ?? 0) + 1);

  return {
    counters: rows,
    totalGranted: logs.filter((l) => l.result === "GRANTED").length,
    totalDenied: logs.filter((l) => l.result === "DENIED").length,
    offlineSynced: logs.filter((l) => l.syncedOffline).length,
    denialReasons: [...denialMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    identityChecks: {
      match: logs.filter((l) => l.identityCheck === "MATCH").length,
      mismatch: logs.filter((l) => l.identityCheck === "MISMATCH").length,
      notRequired: logs.filter((l) => l.identityCheck === "NOT_REQUIRED").length,
    },
  };
}

async function buildIssuesSection(eventId: string): Promise<EventReportSnapshot["issues"]> {
  const { db } = getDb();
  const rows = await db
    .select({
      category: complaints.category,
      status: complaints.status,
      locationName: complaintLocations.label,
    })
    .from(complaints)
    .leftJoin(complaintLocations, eq(complaintLocations.id, complaints.locationId))
    .where(eq(complaints.eventId, eventId));
  const byCategory = new Map<string, number>();
  const byLocation = new Map<string, number>();
  for (const r of rows) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
    const loc = r.locationName ?? "Unspecified";
    byLocation.set(loc, (byLocation.get(loc) ?? 0) + 1);
  }
  const closed = (s: string) => s === "RESOLVED" || s === "CLOSED";
  return {
    total: rows.length,
    open: rows.filter((r) => !closed(r.status)).length,
    resolved: rows.filter((r) => closed(r.status)).length,
    byCategory: [...byCategory.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    byLocation: [...byLocation.entries()]
      .map(([location, count]) => ({ location, count }))
      .sort((a, b) => b.count - a.count),
  };
}

async function buildQuizSection(
  eventId: string,
  capacity: number,
): Promise<EventReportSnapshot["quiz"]> {
  const { db } = getDb();
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.eventId, eventId)).limit(1);
  if (!quiz) return null;
  const attempts = await db.select().from(quizAttempts).where(eq(quizAttempts.quizId, quiz.id));
  const [questionCount] = await db
    .select({ n: sqlCount() })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id));
  const submitted = attempts.filter((a) => a.status === "SUBMITTED");
  const percents = submitted.map((a) => Number.parseFloat(a.percentScore ?? "0"));
  const avg = percents.length
    ? Math.round((percents.reduce((x, y) => x + y, 0) / percents.length) * 100) / 100
    : null;
  return {
    mode: quiz.mode,
    status: quiz.status,
    passScore: quiz.passScore === null ? null : Number.parseFloat(quiz.passScore),
    seats: quiz.seats ?? capacity,
    questionCount: questionCount?.n ?? 0,
    attempts: attempts.length,
    submitted: submitted.length,
    expired: attempts.filter((a) => a.status === "EXPIRED").length,
    qualified: attempts.filter((a) => a.qualified === true).length,
    averagePercent: avg,
    highestPercent: percents.length ? Math.max(...percents) : null,
    allocatedAt: quiz.allocatedAt ? quiz.allocatedAt.toISOString() : null,
    confirmed: attempts.filter((a) => a.allocatedStatus === "CONFIRMED").length,
    waitlisted: attempts.filter((a) => a.allocatedStatus === "WAITLISTED").length,
  };
}

async function buildAnnouncementsSection(
  eventId: string,
): Promise<EventReportSnapshot["announcements"]> {
  const { db } = getDb();
  const rows = await db
    .select()
    .from(announcements)
    .where(eq(announcements.eventId, eventId))
    .orderBy(asc(announcements.publishedAt));
  return rows.map((a) => ({
    title: a.title,
    audience: a.audience,
    publishedAt: a.publishedAt.toISOString(),
    revoked: Boolean(a.revokedAt),
  }));
}

/** Canonical JSON so the checksum is stable regardless of key ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function checksumOf(snapshot: Omit<EventReportSnapshot, "integrity">): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** Reports are only meaningful once the event has actually finished. */
function assertReportable(event: typeof events.$inferSelect) {
  if (event.status === "CANCELLED") return; // a cancelled event still gets a record
  if (event.status !== "COMPLETED" && event.endsAt > new Date())
    throw new ApiError(
      "INVALID_STATE_TRANSITION",
      "The event has not finished yet. A report can be generated after it ends.",
    );
}

export async function generateReport(
  auth: AuthContext,
  eventId: string,
  input: { notes?: string | undefined },
  audit?: AuditContext,
) {
  const { db } = getDb();
  const base = await buildSnapshot(auth, eventId, input.notes);
  const checksum = checksumOf(base);
  const snapshot: EventReportSnapshot = {
    ...base,
    integrity: { algorithm: "sha256", checksum },
  };

  // Render before writing so a PDF failure cannot leave a half-issued report.
  const pdfBytes = await renderReportPdf(snapshot);

  // Upload before opening the transaction: network I/O must not run on the
  // transaction's connection, and a rollback must not orphan a files row.
  let uploaded: Awaited<ReturnType<typeof putReportObject>> | null = null;
  if (canArchiveReports()) {
    uploaded = await putReportObject(eventId, pdfBytes, `${base.event.slug}-report.pdf`);
  }

  try {
    return await db.transaction(async (tx) => {
      const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
      if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
      assertReportable(event);

      const [latest] = await tx
        .select({ sequence: eventReports.sequence })
        .from(eventReports)
        .where(eq(eventReports.eventId, eventId))
        .orderBy(desc(eventReports.sequence))
        .limit(1);
      const sequence = (latest?.sequence ?? 0) + 1;

      let fileId: string | null = null;
      if (uploaded) {
        const [file] = await tx
          .insert(files)
          .values({
            id: uploaded.id,
            ownerId: auth.user.id,
            purpose: "EVENT_REPORT",
            objectKey: uploaded.objectKey,
            bucket: uploaded.bucket,
            mimeType: "application/pdf",
            sizeBytes: uploaded.sizeBytes,
            checksumSha256: uploaded.checksumSha256,
            status: "READY",
            completedAt: new Date(),
          })
          .returning();
        if (!file) throw new ApiError("INTERNAL_ERROR", "Report archive failed.");
        fileId = file.id;
      }

      const [report] = await tx
        .insert(eventReports)
        .values({
          eventId,
          eventRevision: event.currentRevision,
          sequence,
          generatedBy: auth.user.id,
          snapshot,
          checksumSha256: checksum,
          fileId,
        })
        .returning();
      if (!report) throw new ApiError("INTERNAL_ERROR", "Report creation failed.");

      await tx
        .update(events)
        .set({ reportGeneratedAt: new Date(), updatedAt: new Date() })
        .where(eq(events.id, eventId));

      if (audit)
        await insertAudit(tx, audit, {
          action: "EVENT_REPORT_GENERATED",
          entityType: "event_report",
          entityId: report.id,
          clubId: event.clubId,
          eventId,
          after: {
            sequence,
            checksum,
            archived: Boolean(fileId),
            attendees: snapshot.attendees.length,
          },
        });

      return { report, snapshot, archived: Boolean(fileId) };
    });
  } catch (err) {
    if (uploaded) await deleteReportObject(uploaded.objectKey, uploaded.bucket);
    throw err;
  }
}

export async function listReports(auth: AuthContext, eventId: string) {
  await assertReportAccess(auth, eventId);
  const { db } = getDb();
  const rows = await db
    .select({ report: eventReports, generator: { id: users.id, fullName: users.fullName } })
    .from(eventReports)
    .innerJoin(users, eq(users.id, eventReports.generatedBy))
    .where(eq(eventReports.eventId, eventId))
    .orderBy(desc(eventReports.sequence));
  return {
    items: rows.map((r) => ({
      id: r.report.id,
      sequence: r.report.sequence,
      eventRevision: r.report.eventRevision,
      generatedBy: r.generator,
      generatedAt: r.report.createdAt,
      checksum: r.report.checksumSha256,
      archivedFileId: r.report.fileId,
    })),
  };
}

export async function getReport(auth: AuthContext, eventId: string, reportId: string) {
  await assertReportAccess(auth, eventId);
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(eventReports)
    .where(and(eq(eventReports.id, reportId), eq(eventReports.eventId, eventId)))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Report not found.");
  const snapshot = row.snapshot as EventReportSnapshot;
  // Verify the filed record has not been altered outside the application.
  const { integrity: _integrity, ...base } = snapshot;
  const recomputed = checksumOf(base);
  return {
    report: row,
    snapshot,
    integrity: {
      expected: row.checksumSha256,
      recomputed,
      verified: recomputed === row.checksumSha256,
    },
  };
}

/** Re-render the PDF from the stored snapshot so a download always matches what was filed. */
export async function renderStoredReport(auth: AuthContext, eventId: string, reportId: string) {
  const { snapshot, report, integrity } = await getReport(auth, eventId, reportId);
  if (!integrity.verified)
    throw new ApiError("CONFLICT", "This report failed its integrity check and cannot be issued.");
  const bytes = await renderReportPdf(snapshot);
  return { bytes, snapshot, report };
}

export { renderReportPdf };
