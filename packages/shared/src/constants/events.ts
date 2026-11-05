export const EVENT_TEMPLATES = [
  "WORKSHOP",
  "SEMINAR",
  "WEBINAR",
  "HACKATHON",
  "PLACEMENT_DRIVE",
  "SPORTS",
  "COMPETITION",
  "CUSTOM",
] as const;
export type EventTemplate = (typeof EVENT_TEMPLATES)[number];

export const EVENT_STATUSES = [
  "DRAFT",
  "PENDING_APPROVALS",
  "READY",
  "PUBLISHED",
  "LIVE",
  "COMPLETED",
  "CANCELLED",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_AUDIENCES = ["COLLEGE_ONLY", "OUTSIDERS_ALLOWED", "INVITED_ONLY"] as const;
export type EventAudience = (typeof EVENT_AUDIENCES)[number];

export const ADMISSION_MODES = ["FCFS", "MANUAL", "QUIZ_TOP_N", "QUIZ_FIRST_QUALIFIED"] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

export const APPROVAL_TYPES = ["ORGANIZE", "INVITE_OUTSIDERS", "RESOURCE_USE", "CUSTOM"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_ACTION_TYPES = [
  "SUBMIT",
  "APPROVE",
  "REJECT",
  "ESCALATE",
  "REQUEST_CHANGES",
  "RESUBMIT",
  "REASSIGN",
  "CANCEL",
] as const;
export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number];

export const RESOURCE_KINDS = ["VENUE", "LAB", "EQUIPMENT", "OTHER"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_STATUSES = ["ACTIVE", "MAINTENANCE", "RETIRED"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

/** Shared by resources and their bookable units: both use the same enum. */
export const RESOURCE_STATUS_LABELS: Record<ResourceStatus, string> = {
  ACTIVE: "Active",
  MAINTENANCE: "Under maintenance",
  RETIRED: "Retired",
};

export const RESERVATION_STATUSES = ["HELD", "CONFIRMED", "RELEASED", "EXPIRED"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const REGISTRATION_STATUSES = [
  "APPLIED",
  "CONFIRMED",
  "WAITLISTED",
  "REJECTED",
  "CANCELLED",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Human labels for UI surfaces. Enum values stay stable in the database. */
export const EVENT_TEMPLATE_LABELS: Record<EventTemplate, string> = {
  WORKSHOP: "Workshop",
  SEMINAR: "Seminar",
  WEBINAR: "Webinar",
  HACKATHON: "Hackathon",
  PLACEMENT_DRIVE: "Placement drive",
  SPORTS: "Sports",
  COMPETITION: "Competition",
  CUSTOM: "Custom event",
};

export const EVENT_AUDIENCE_LABELS: Record<EventAudience, string> = {
  COLLEGE_ONLY: "College only",
  OUTSIDERS_ALLOWED: "Open to outsiders",
  INVITED_ONLY: "Invited only",
};

export const ADMISSION_MODE_LABELS: Record<AdmissionMode, string> = {
  FCFS: "First come, first served",
  MANUAL: "Manual selection",
  QUIZ_TOP_N: "Top quiz scorers",
  QUIZ_FIRST_QUALIFIED: "First to qualify",
};

export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  ORGANIZE: "Permission to organize",
  INVITE_OUTSIDERS: "Permission to invite outsiders",
  RESOURCE_USE: "Resource use",
  CUSTOM: "Additional permission",
};

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  VENUE: "Venue",
  LAB: "Lab / room",
  EQUIPMENT: "Equipment",
  OTHER: "Other",
};
