/**
 * The delivery phase this build implements. Health, the root banner and the web
 * shell all read this so the number cannot drift between surfaces.
 */
export const IMPLEMENTATION_PHASE = 7;

/**
 * What one access QR DOES. The coordinator picks this per QR; there is no fixed
 * list of "entry/meal/library" purposes, because those were only examples. Any
 * name is allowed ("Entry", "Attendance", "Lab 3", "xyz").
 *
 * ONE_TIME  — one scan per participant, ever.
 * TOGGLE    — alternates: first scan records an IN, the next an OUT, and so on.
 *             Use it for a gate where you want both directions from one QR.
 * COUNTED   — a fixed number of scans per participant (2, 3, 10 …).
 * UNLIMITED — any number of scans while the QR is valid.
 */
export const QR_TYPES = ["ONE_TIME", "TOGGLE", "COUNTED", "UNLIMITED"] as const;
export type QrType = (typeof QR_TYPES)[number];

export const QR_TYPE_LABELS: Record<QrType, string> = {
  ONE_TIME: "One time",
  TOGGLE: "Toggle (in / out)",
  COUNTED: "Set number of uses",
  UNLIMITED: "Unlimited",
};

export const QR_TYPE_HINTS: Record<QrType, string> = {
  ONE_TIME: "Each participant can scan this once.",
  TOGGLE: "First scan records an entry, the next an exit, then entry again.",
  COUNTED: "Each participant gets the number of scans you set.",
  UNLIMITED: "Scan as often as needed while the QR is valid.",
};

/** Which QR types need a use count. */
export function qrTypeNeedsMaxUses(type: QrType): boolean {
  return type === "COUNTED";
}

/** The effective limit for a type: null means no cap. */
export function qrTypeLimit(type: QrType, maxUses: number | null): number | null {
  if (type === "ONE_TIME") return 1;
  if (type === "COUNTED") return maxUses;
  return null;
}

/**
 * WHEN the QR is accepted.
 * WINDOW — between two date-times.
 * DATE   — one calendar day, midnight to midnight in the campus timezone.
 * MANUAL — no clock at all: only while a coordinator has it switched on.
 *
 * In every mode the on/off switch still applies, so a QR can be paused even
 * inside its window.
 */
export const QR_VALIDITY_MODES = ["WINDOW", "DATE", "MANUAL"] as const;
export type QrValidityMode = (typeof QR_VALIDITY_MODES)[number];

export const QR_VALIDITY_LABELS: Record<QrValidityMode, string> = {
  WINDOW: "Between two times",
  DATE: "On one date",
  MANUAL: "Only while switched on",
};

export const QR_VALIDITY_HINTS: Record<QrValidityMode, string> = {
  WINDOW: "Accepted from the start time until the end time.",
  DATE: "Accepted for that whole day, in the campus timezone.",
  MANUAL: "No schedule. Accepted only while you keep it switched on.",
};

/** Which way a TOGGLE scan counted. */
export const QR_DIRECTIONS = ["IN", "OUT"] as const;
export type QrDirection = (typeof QR_DIRECTIONS)[number];

export const QR_DIRECTION_LABELS: Record<QrDirection, string> = {
  IN: "Entry",
  OUT: "Exit",
};

/** Odd uses are entries, even uses are exits. */
export function toggleDirectionForUse(useNumber: number): QrDirection {
  return useNumber % 2 === 1 ? "IN" : "OUT";
}

export const SCAN_RESULTS = ["GRANTED", "DENIED"] as const;
export type ScanResult = (typeof SCAN_RESULTS)[number];

export const IDENTITY_CHECK_RESULTS = ["MATCH", "MISMATCH", "NOT_REQUIRED"] as const;
export type IdentityCheckResult = (typeof IDENTITY_CHECK_RESULTS)[number];

export const COMPLAINT_CATEGORIES = [
  "POWER",
  "WIFI",
  "EQUIPMENT",
  "VENUE",
  "SAFETY",
  "OTHER",
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

/** Human labels so no raw enum reaches a screen. */
export const COMPLAINT_CATEGORY_LABELS: Record<ComplaintCategory, string> = {
  POWER: "Power / electricity",
  WIFI: "Wi-Fi / network",
  EQUIPMENT: "Equipment",
  VENUE: "Venue / seating",
  SAFETY: "Safety",
  OTHER: "Something else",
};

export const COMPLAINT_STATUSES = [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_STATUS_LABELS: Record<ComplaintStatus, string> = {
  OPEN: "Open",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

export const QUIZ_MODES = ["TOP_N", "FIRST_QUALIFIED"] as const;
export type QuizMode = (typeof QUIZ_MODES)[number];

export const QUIZ_STATUSES = ["DRAFT", "PUBLISHED", "PAUSED", "CLOSED"] as const;
export type QuizStatus = (typeof QUIZ_STATUSES)[number];

export const QUIZ_STATUS_LABELS: Record<QuizStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Open for attempts",
  PAUSED: "Paused by coordinators",
  CLOSED: "Closed",
};

/** Who an announcement reaches. */
export const ANNOUNCEMENT_AUDIENCES = ["REGISTERED", "ALL_VISIBLE"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];
export const ANNOUNCEMENT_AUDIENCE_LABELS: Record<AnnouncementAudience, string> = {
  REGISTERED: "Registered participants",
  ALL_VISIBLE: "Everyone who can see the event",
};

/** Organiser decision on a MANUAL application. */
export const APPLICATION_DECISIONS = ["CONFIRMED", "REJECTED"] as const;
export type ApplicationDecision = (typeof APPLICATION_DECISIONS)[number];

export const QUIZ_ATTEMPT_STATUSES = ["IN_PROGRESS", "SUBMITTED", "EXPIRED"] as const;
export type QuizAttemptStatus = (typeof QUIZ_ATTEMPT_STATUSES)[number];

/** All purposes the database recognises. Must stay in step with the file_purpose enum. */
export const FILE_PURPOSES = [
  "PROFILE_PHOTO",
  "COLLEGE_ID_PROOF",
  "EVENT_BANNER",
  "EVENT_REPORT",
  "ATTENDEE_EXPORT",
  "COMPLAINT_ATTACHMENT",
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * The subset a client may upload directly. EVENT_REPORT is produced server-side;
 * ATTENDEE_EXPORT and COMPLAINT_ATTACHMENT arrive with their own phases.
 */
export const UPLOADABLE_FILE_PURPOSES = [
  "PROFILE_PHOTO",
  "COLLEGE_ID_PROOF",
  "EVENT_BANNER",
] as const;
export type UploadableFilePurpose = (typeof UPLOADABLE_FILE_PURPOSES)[number];

export const FILE_STATUSES = ["PENDING", "READY", "REJECTED", "DELETED"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * Defaults only. The running API reads CAMPUS_TIMEZONE and QR_TTL_SECONDS from
 * its environment so a different institution can change them without a rebuild.
 */
export const DEFAULT_CAMPUS_TIMEZONE = "Asia/Kolkata";
export const DEFAULT_QR_TTL_SECONDS = 60;
