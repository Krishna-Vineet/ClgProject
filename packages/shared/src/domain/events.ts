import type { AdmissionMode, EventAudience, EventStatus } from "../constants/events";

/**
 * Event lifecycle. One engine for every template.
 *
 * DRAFT → PENDING_APPROVALS → READY → PUBLISHED → LIVE → COMPLETED
 *                ↓ (changes requested / rejected)
 *              DRAFT (new revision required)
 * Any non-terminal state → CANCELLED.
 */

export const EVENT_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  DRAFT: ["PENDING_APPROVALS", "CANCELLED"],
  PENDING_APPROVALS: ["READY", "DRAFT", "CANCELLED"],
  READY: ["PUBLISHED", "DRAFT", "CANCELLED"],
  PUBLISHED: ["LIVE", "DRAFT", "CANCELLED"],
  LIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return EVENT_TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: EventStatus): boolean {
  return EVENT_TRANSITIONS[status].length === 0;
}

/** Statuses that a normal participant may discover. */
export const DISCOVERABLE_STATUSES: readonly EventStatus[] = ["PUBLISHED", "LIVE", "COMPLETED"];

export function isDiscoverable(status: EventStatus): boolean {
  return DISCOVERABLE_STATUSES.includes(status);
}

/**
 * The status an event has *now*, independent of the maintenance job.
 *
 * A free host cannot run a minute-by-minute cron, and a gate cannot wait for one.
 * PUBLISHED becomes LIVE at startsAt and PUBLISHED/LIVE becomes COMPLETED at
 * endsAt for decision-making, while the stored status catches up in the
 * background. The database row remains the record; this is only the clock.
 */
export function effectiveEventStatus(
  status: EventStatus | string,
  startsAt: string | Date,
  endsAt: string | Date,
  at: Date = new Date(),
): EventStatus | string {
  const now = at.getTime();
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (status === "CANCELLED" || status === "COMPLETED") return status;
  if ((status === "PUBLISHED" || status === "LIVE") && Number.isFinite(end) && end <= now)
    return "COMPLETED";
  if (status === "PUBLISHED" && Number.isFinite(start) && start <= now) return "LIVE";
  return status;
}

/**
 * Editing rules.
 *
 * A coordinator can always fix the things that do not change what was approved:
 * a typo in the title, a better description, the banner. What was approved is
 * *when*, *where* and *with what* — so a change to the schedule, the venue or the
 * resources behind it drops the event back to a draft revision and re-opens
 * approvals. Freezing the whole event for a description fix teaches people to
 * route around the product; freezing only the approved facts keeps the audit
 * trail honest without getting in the way.
 */
export const REVISION_FORCING_EVENT_FIELDS = [
  "startsAt",
  "endsAt",
  "registrationOpensAt",
  "registrationClosesAt",
  "venueSummary",
  "onlineMeetingUrl",
] as const;

export type RevisionForcingEventField = (typeof REVISION_FORCING_EVENT_FIELDS)[number];

/** A finished or abandoned event is history; nothing about it is editable. */
export function canEditEvent(status: EventStatus): boolean {
  return status !== "COMPLETED" && status !== "CANCELLED";
}

/**
 * Does this edit touch something that was approved?
 *
 * The caller passes only the keys the client sent, so an absent field never
 * counts as a change. `updateEvent` uses this to decide, in one transaction,
 * whether the edit lands in place or becomes a new draft revision.
 */
export function requiresRevision(attemptedFields: readonly string[]): boolean {
  return attemptedFields.some((field) =>
    (REVISION_FORCING_EVENT_FIELDS as readonly string[]).includes(field),
  );
}

/**
 * Fields that invalidate existing approvals when changed after submission.
 * Cosmetic fields (description, banner) do not force re-approval.
 */
export const CRITICAL_EVENT_FIELDS = [
  "title",
  "audience",
  "admissionMode",
  "capacity",
  "startsAt",
  "endsAt",
  "registrationOpensAt",
  "registrationClosesAt",
  "venueSummary",
  "onlineMeetingUrl",
  "eligibilityPolicy",
] as const;

export type CriticalEventField = (typeof CRITICAL_EVENT_FIELDS)[number];

export function changedCriticalFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): CriticalEventField[] {
  const changed: CriticalEventField[] = [];
  for (const field of CRITICAL_EVENT_FIELDS) {
    if (!(field in after)) continue;
    const a = normalize(before[field]);
    const b = normalize(after[field]);
    if (a !== b) changed.push(field);
  }
  return changed;
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(sortKeys(value));
  return String(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export type EventWindowInput = {
  startsAt: string | Date;
  endsAt: string | Date;
  registrationOpensAt: string | Date;
  registrationClosesAt: string | Date;
};

/** Mirrors the DB checks so the API can return a 400 instead of a 500. */
export function validateEventWindow(input: EventWindowInput, now = new Date()): string[] {
  const problems: string[] = [];
  const starts = new Date(input.startsAt).getTime();
  const ends = new Date(input.endsAt).getTime();
  const opens = new Date(input.registrationOpensAt).getTime();
  const closes = new Date(input.registrationClosesAt).getTime();
  if (![starts, ends, opens, closes].every(Number.isFinite)) {
    return ["Event and registration timestamps must be valid ISO dates."];
  }
  if (ends <= starts) problems.push("endsAt must be after startsAt.");
  if (closes <= opens) problems.push("registrationClosesAt must be after registrationOpensAt.");
  if (closes > starts) problems.push("Registration must close at or before the event starts.");
  if (ends <= now.getTime()) problems.push("The event must end in the future.");
  return problems;
}

/**
 * Admission must be decidable by something that actually exists.
 *
 * Quiz-ranked admission is only meaningful once a quiz is attached to the event;
 * without one there is no score to rank and no qualification to test, so the
 * event could never admit anyone. Quizzes land in Phase 7 — until an event has a
 * linked quiz, the quiz modes are refused rather than silently behaving like FCFS.
 *
 * INVITED_ONLY constrains *who may see and apply*, not how seats are ranked, so
 * every admission mode remains valid for it.
 */
export function validateAdmissionForAudience(
  _audience: EventAudience,
  admissionMode: AdmissionMode,
  options: { hasLinkedQuiz?: boolean } = {},
): string[] {
  const quizModes: AdmissionMode[] = ["QUIZ_TOP_N", "QUIZ_FIRST_QUALIFIED"];
  if (quizModes.includes(admissionMode) && !options.hasLinkedQuiz) {
    return [
      `${admissionMode} needs a quiz attached to the event. Attach a quiz first, or use FCFS or MANUAL admission.`,
    ];
  }
  return [];
}

export type PublishCheckInput = {
  status: EventStatus;
  requiredApprovalsReady: boolean;
  hasRequiredApprovals: boolean;
  resourceHoldsValid: boolean;
  now?: Date;
  registrationClosesAt: string | Date;
};

export type PublishCheck = { allowed: boolean; code: string | null; message: string | null };

export function checkPublishable(input: PublishCheckInput): PublishCheck {
  const now = input.now ?? new Date();
  if (input.status === "DRAFT") {
    return {
      allowed: false,
      code: "APPROVAL_REQUIRED",
      message: "Submit this revision for approval before publishing.",
    };
  }
  if (input.status !== "READY" && input.status !== "PENDING_APPROVALS") {
    return {
      allowed: false,
      code: "CONFLICT",
      message: `An event in ${input.status} cannot be published.`,
    };
  }
  if (!input.hasRequiredApprovals) {
    return {
      allowed: false,
      code: "APPROVAL_REQUIRED",
      message: "Submit the event for approval before publishing.",
    };
  }
  if (!input.requiredApprovalsReady) {
    return {
      allowed: false,
      code: "APPROVAL_REQUIRED",
      message: "All required approvals must be approved before publishing.",
    };
  }
  if (!input.resourceHoldsValid) {
    return {
      allowed: false,
      code: "RESOURCE_CONFLICT",
      message: "A required resource hold expired or was released. Request the resource again.",
    };
  }
  if (new Date(input.registrationClosesAt).getTime() < now.getTime()) {
    return {
      allowed: false,
      code: "EVENT_WINDOW_INVALID",
      message: "Registration already closed. Update the schedule before publishing.",
    };
  }
  return { allowed: true, code: null, message: null };
}
