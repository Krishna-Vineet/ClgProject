import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = (name = "id") => uuid(name).primaryKey().defaultRandom();
const createdAt = () => tz("created_at").notNull().defaultNow();
const updatedAt = () => tz("updated_at").notNull().defaultNow();

export const accountType = pgEnum("account_type", ["COLLEGE_STUDENT", "OUTSIDER_STUDENT", "STAFF"]);
export const accountStatus = pgEnum("account_status", [
  "PENDING_EMAIL",
  "PENDING_VERIFICATION",
  "ACTIVE",
  "REJECTED",
  "SUSPENDED",
]);
export const globalRole = pgEnum("global_role", ["ADMIN", "FACULTY", "HOD_DEAN", "SUPPORT"]);
export const roleScope = pgEnum("role_scope", ["GLOBAL", "DEPARTMENT"]);
export const clubRole = pgEnum("club_role", ["LEAD", "COORDINATOR", "FACULTY"]);
export const staffPosition = pgEnum("staff_position", [
  "HOD",
  "DEAN",
  "PROFESSOR",
  "ASSISTANT_PROFESSOR",
  "OTHER",
]);
export const eventTemplate = pgEnum("event_template", [
  "WORKSHOP",
  "SEMINAR",
  "WEBINAR",
  "HACKATHON",
  "PLACEMENT_DRIVE",
  "SPORTS",
  "CUSTOM",
]);
export const eventStatus = pgEnum("event_status", [
  "DRAFT",
  "PENDING_APPROVALS",
  "READY",
  "PUBLISHED",
  "LIVE",
  "COMPLETED",
  "CANCELLED",
]);
export const eventAudience = pgEnum("event_audience", [
  "COLLEGE_ONLY",
  "OUTSIDERS_ALLOWED",
  "INVITED_ONLY",
]);
export const admissionMode = pgEnum("admission_mode", [
  "FCFS",
  "MANUAL",
  "QUIZ_TOP_N",
  "QUIZ_FIRST_QUALIFIED",
]);
export const approvalType = pgEnum("approval_type", [
  "ORGANIZE",
  "INVITE_OUTSIDERS",
  "RESOURCE_USE",
  "CUSTOM",
]);
export const approvalTier = pgEnum("approval_tier", ["FACULTY", "SENIOR", "ADMIN"]);
export const approvalStatus = pgEnum("approval_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
]);
export const approvalActionType = pgEnum("approval_action_type", [
  "SUBMIT",
  "APPROVE",
  "REJECT",
  "ESCALATE",
  "REQUEST_CHANGES",
  "RESUBMIT",
  "REASSIGN",
  "CANCEL",
]);
export const resourceKind = pgEnum("resource_kind", ["VENUE", "LAB", "EQUIPMENT", "OTHER"]);
export const resourceStatus = pgEnum("resource_status", ["ACTIVE", "MAINTENANCE", "RETIRED"]);
export const reservationStatus = pgEnum("reservation_status", [
  "HELD",
  "CONFIRMED",
  "RELEASED",
  "EXPIRED",
]);
export const registrationStatus = pgEnum("registration_status", [
  "APPLIED",
  "CONFIRMED",
  "WAITLISTED",
  "REJECTED",
  "CANCELLED",
]);
export const qrType = pgEnum("qr_type", ["ONE_TIME", "TOGGLE", "COUNTED", "UNLIMITED"]);
export const qrValidityMode = pgEnum("qr_validity_mode", ["WINDOW", "DATE", "MANUAL"]);
export const qrDirection = pgEnum("qr_direction", ["IN", "OUT"]);
export const scanResult = pgEnum("scan_result", ["GRANTED", "DENIED"]);
export const identityCheckResult = pgEnum("identity_check_result", [
  "MATCH",
  "MISMATCH",
  "NOT_REQUIRED",
]);
export const complaintCategory = pgEnum("complaint_category", [
  "POWER",
  "WIFI",
  "EQUIPMENT",
  "VENUE",
  "SAFETY",
  "OTHER",
]);
export const complaintStatus = pgEnum("complaint_status", [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
]);
export const quizMode = pgEnum("quiz_mode", ["TOP_N", "FIRST_QUALIFIED"]);
export const quizStatus = pgEnum("quiz_status", ["DRAFT", "PUBLISHED", "CLOSED"]);
export const quizAttemptStatus = pgEnum("quiz_attempt_status", [
  "IN_PROGRESS",
  "SUBMITTED",
  "EXPIRED",
]);
export const filePurpose = pgEnum("file_purpose", [
  "PROFILE_PHOTO",
  "COLLEGE_ID_PROOF",
  "EVENT_BANNER",
  "EVENT_REPORT",
  "ATTENDEE_EXPORT",
  "COMPLAINT_ATTACHMENT",
]);
export const fileStatus = pgEnum("file_status", ["PENDING", "READY", "REJECTED", "DELETED"]);
export const authTokenPurpose = pgEnum("auth_token_purpose", [
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "STAFF_SETUP",
]);

export const departments = pgTable("departments", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const programs = pgTable(
  "programs",
  {
    id: id(),
    name: text("name").notNull(),
    departmentId: uuid("department_id").references(() => departments.id),
    foundationDepartmentId: uuid("foundation_department_id").references(() => departments.id),
    foundationYears: integer("foundation_years").notNull().default(0),
    durationYears: integer("duration_years").notNull().default(4),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("programs_name_unique").on(sql`lower(${t.name})`),
    check(
      "programs_foundation_years_valid",
      sql`${t.foundationYears} >= 0 AND ${t.foundationYears} <= ${t.durationYears}`,
    ),
    check("programs_duration_years_valid", sql`${t.durationYears} between 1 and 12`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    accountType: accountType("account_type").notNull(),
    status: accountStatus("status").notNull().default("PENDING_EMAIL"),
    emailVerifiedAt: tz("email_verified_at"),
    fullName: text("full_name").notNull(),
    phone: text("phone"),
    phoneVerifiedAt: tz("phone_verified_at"),
    consentAcceptedAt: tz("consent_accepted_at"),
    /** Version of the policy the user accepted; null for rows captured before versioning. */
    consentVersion: text("consent_version"),
    /**
     * Set when the person asked to be forgotten. The row stays because the
     * institution's event history references it; every identifying field is
     * overwritten in the same transaction.
     */
    anonymisedAt: tz("anonymised_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastLoginAt: tz("last_login_at"),
    passwordUpdatedAt: tz("password_updated_at"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: filePurpose("purpose").notNull(),
    objectKey: text("object_key").notNull().unique(),
    storageProvider: text("storage_provider").notNull().default("s3"),
    bucket: text("bucket"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256"),
    status: fileStatus("status").notNull().default("PENDING"),
    completedAt: tz("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("files_size_nonnegative", sql`${t.sizeBytes} >= 0`),
    check("files_storage_provider", sql`${t.storageProvider} in ('s3')`),
    check("files_ready_requires_bucket", sql`${t.status} <> 'READY' or ${t.bucket} is not null`),
  ],
);

export const studentProfiles = pgTable(
  "student_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    studentKind: accountType("student_kind").notNull(),
    institutionName: text("institution_name").notNull(),
    rollNumber: text("roll_number"),
    departmentId: uuid("department_id").references(() => departments.id),
    programId: uuid("program_id").references(() => programs.id),
    program: text("program"),
    studyYear: integer("study_year"),
    graduationYear: integer("graduation_year"),
    collegeIdNumber: text("college_id_number"),
    photoFileId: uuid("photo_file_id").references(() => files.id),
    idProofFileId: uuid("id_proof_file_id").references(() => files.id),
    verifiedBy: uuid("verified_by").references(() => users.id),
    verifiedAt: tz("verified_at"),
    rejectionReason: text("rejection_reason"),
    profileVersion: integer("profile_version").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("student_roll_unique")
      .on(t.institutionName, t.rollNumber)
      .where(sql`${t.rollNumber} is not null`),
    check(
      "college_profile_requires_department",
      sql`${t.studentKind} <> 'COLLEGE_STUDENT' OR ${t.departmentId} is not null`,
    ),
    check("student_kind_valid", sql`${t.studentKind} in ('COLLEGE_STUDENT','OUTSIDER_STUDENT')`),
    check("graduation_year_range", sql`${t.graduationYear} between 2000 and 2100`),
    check(
      "student_study_year_valid",
      sql`${t.studyYear} is null or ${t.studyYear} between 1 and 12`,
    ),
    check("profile_version_positive", sql`${t.profileVersion} > 0`),
    check(
      "student_verification_pair",
      sql`(${t.verifiedAt} is null and ${t.verifiedBy} is null) or (${t.verifiedAt} is not null and ${t.verifiedBy} is not null)`,
    ),
  ],
);

export const staffProfiles = pgTable(
  "staff_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    employeeCode: text("employee_code").unique(),
    departmentId: uuid("department_id").references(() => departments.id),
    designation: text("designation").notNull(),
    position: staffPosition("position").notNull().default("OTHER"),
    photoFileId: uuid("photo_file_id").references(() => files.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("staff_profiles_position_idx").on(t.position),
    index("staff_profiles_department_idx").on(t.departmentId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    /**
     * One sign-in chain: login creates the id, every rotation carries it forward.
     * Reuse detection revokes a family, never the user's other devices.
     */
    familyId: uuid("family_id").notNull(),
    deviceLabel: text("device_label"),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    expiresAt: tz("expires_at").notNull(),
    revokedAt: tz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_family_idx").on(t.familyId)],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: authTokenPurpose("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    otpHash: text("otp_hash"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastSentAt: tz("last_sent_at"),
    deliveryStatus: text("delivery_status").notNull().default("PENDING"),
    expiresAt: tz("expires_at").notNull(),
    consumedAt: tz("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("auth_tokens_user_idx").on(t.userId, t.purpose),
    check(
      "auth_tokens_attempts_range",
      sql`${t.attempts} >= 0 and ${t.maxAttempts} between 1 and 10`,
    ),
    check(
      "auth_tokens_delivery_status",
      sql`${t.deliveryStatus} in ('PENDING','SENT','FAILED','DEMO')`,
    ),
  ],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: globalRole("role").notNull(),
    scopeType: roleScope("scope_type").notNull(),
    departmentId: uuid("department_id").references(() => departments.id),
    grantedBy: uuid("granted_by").references(() => users.id),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("role_assignment_unique").on(
      t.userId,
      t.role,
      t.scopeType,
      sql`coalesce(${t.departmentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    check(
      "role_scope_matches_department",
      sql`(${t.scopeType} = 'GLOBAL' and ${t.departmentId} is null) or (${t.scopeType} = 'DEPARTMENT' and ${t.departmentId} is not null)`,
    ),
    check("role_assignments_admin_global", sql`${t.role} <> 'ADMIN' or ${t.scopeType} = 'GLOBAL'`),
  ],
);

export const clubs = pgTable("clubs", {
  id: id(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  departmentId: uuid("department_id").references(() => departments.id),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
});

export const clubMemberships = pgTable(
  "club_memberships",
  {
    id: id(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clubRole: clubRole("club_role").notNull().default("COORDINATOR"),
    isActive: boolean("is_active").notNull().default(true),
    addedBy: uuid("added_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("club_memberships_club_user_unique").on(t.clubId, t.userId)],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    template: eventTemplate("template").notNull().default("CUSTOM"),
    status: eventStatus("status").notNull().default("DRAFT"),
    audience: eventAudience("audience").notNull().default("COLLEGE_ONLY"),
    admissionMode: admissionMode("admission_mode").notNull().default("FCFS"),
    eligibilityPolicy: jsonb("eligibility_policy").notNull().default({ version: 1 }),
    capacity: integer("capacity").notNull(),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    registrationOpensAt: tz("registration_opens_at").notNull(),
    registrationClosesAt: tz("registration_closes_at").notNull(),
    venueSummary: text("venue_summary"),
    onlineMeetingUrl: text("online_meeting_url"),
    currentRevision: integer("current_revision").notNull().default(1),
    publishedAt: tz("published_at"),
    cancelledAt: tz("cancelled_at"),
    cancellationReason: text("cancellation_reason"),
    submittedAt: tz("submitted_at"),
    readyAt: tz("ready_at"),
    completedAt: tz("completed_at"),
    jobDescription: text("job_description"),
    bannerFileId: uuid("banner_file_id").references(() => files.id),
    reportSummary: text("report_summary"),
    reportGeneratedAt: tz("report_generated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_club_status_idx").on(t.clubId, t.status),
    index("events_club_created_idx").on(t.clubId, t.createdAt),
    check(
      "events_published_requires_timestamp",
      sql`${t.status} not in ('PUBLISHED','LIVE','COMPLETED') or ${t.publishedAt} is not null`,
    ),
    check(
      "events_cancelled_requires_reason",
      sql`${t.status} <> 'CANCELLED' or ${t.cancellationReason} is not null`,
    ),
    index("events_public_time_idx").on(t.status, t.startsAt),
    check("events_time_order", sql`${t.endsAt} > ${t.startsAt}`),
    check("events_registration_order", sql`${t.registrationClosesAt} > ${t.registrationOpensAt}`),
    check("events_registration_closes_by_start", sql`${t.registrationClosesAt} <= ${t.startsAt}`),
    check("events_capacity_positive", sql`${t.capacity} > 0`),
    check("events_revision_positive", sql`${t.currentRevision} > 0`),
  ],
);

export const eventRevisions = pgTable(
  "event_revisions",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    changedFields: jsonb("changed_fields").notNull().default([]),
    note: text("note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("event_revisions_event_revision_unique").on(t.eventId, t.revision),
    check("event_revisions_revision_positive", sql`${t.revision} > 0`),
  ],
);

export const eventInvitations = pgTable(
  "event_invitations",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    userId: uuid("user_id").references(() => users.id),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    acceptedAt: tz("accepted_at"),
    revokedAt: tz("revoked_at"),
    expiresAt: tz("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("event_invitations_event_email_unique").on(t.eventId, t.email),
    check("event_invitations_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

export const approvalBundles = pgTable(
  "approval_bundles",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    eventRevisionId: uuid("event_revision_id")
      .notNull()
      .references(() => eventRevisions.id),
    supersededAt: tz("superseded_at"),
    submittedBy: uuid("submitted_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("approval_bundles_event_revision_unique").on(t.eventId, t.eventRevisionId),
    uniqueIndex("approval_bundles_one_current_per_event")
      .on(t.eventId)
      .where(sql`${t.supersededAt} is null`),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: id(),
    bundleId: uuid("bundle_id")
      .notNull()
      .references(() => approvalBundles.id, { onDelete: "cascade" }),
    type: approvalType("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    isRequired: boolean("is_required").notNull().default(true),
    currentTier: approvalTier("current_tier").notNull().default("FACULTY"),
    assignedApproverId: uuid("assigned_approver_id").references(() => users.id),
    status: approvalStatus("status").notNull().default("PENDING"),
    payload: jsonb("payload").notNull().default({}),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    decidedAt: tz("decided_at"),
    decidedBy: uuid("decided_by").references(() => users.id),
    tierEnteredAt: tz("tier_entered_at").notNull().defaultNow(),
    dueAt: tz("due_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("approval_requests_inbox_idx").on(t.assignedApproverId, t.status, t.currentTier),
    index("approval_requests_tier_queue_idx")
      .on(t.currentTier, t.status, t.tierEnteredAt)
      .where(sql`${t.status} = 'PENDING'`),
    uniqueIndex("approval_requests_one_organize_per_bundle")
      .on(t.bundleId)
      .where(sql`${t.type} = 'ORGANIZE'`),
    uniqueIndex("approval_requests_one_outsider_per_bundle")
      .on(t.bundleId)
      .where(sql`${t.type} = 'INVITE_OUTSIDERS'`),
    check("approval_requests_version_positive", sql`${t.version} > 0`),
    check(
      "approval_requests_decided_state",
      sql`(${t.status} in ('APPROVED','REJECTED') and ${t.decidedAt} is not null and ${t.decidedBy} is not null) or ${t.status} in ('PENDING','CHANGES_REQUESTED','CANCELLED')`,
    ),
    check(
      "approval_requests_faculty_assignee",
      sql`${t.currentTier} <> 'FACULTY' or ${t.assignedApproverId} is not null`,
    ),
  ],
);

export const approvalActions = pgTable(
  "approval_actions",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    action: approvalActionType("action").notNull(),
    fromTier: approvalTier("from_tier"),
    toTier: approvalTier("to_tier"),
    fromStatus: approvalStatus("from_status"),
    toStatus: approvalStatus("to_status"),
    comment: text("comment"),
    requestVersion: integer("request_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("approval_actions_request_idx").on(t.requestId, t.createdAt)],
);

export const resources = pgTable(
  "resources",
  {
    id: id(),
    departmentId: uuid("department_id").references(() => departments.id),
    kind: resourceKind("kind").notNull(),
    name: text("name").notNull(),
    code: text("code").notNull().unique(),
    description: text("description"),
    status: resourceStatus("status").notNull().default("ACTIVE"),
    capacity: integer("capacity"),
    metadata: jsonb("metadata").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("resources_department_kind_idx").on(t.departmentId, t.kind),
    check("resources_capacity_positive", sql`${t.capacity} is null or ${t.capacity} > 0`),
  ],
);

export const resourceUnits = pgTable(
  "resource_units",
  {
    id: id(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    code: text("code").notNull().unique(),
    status: resourceStatus("status").notNull().default("ACTIVE"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("resource_units_resource_label_unique").on(t.resourceId, t.label),
    index("resource_units_resource_idx").on(t.resourceId),
  ],
);

export const approvalRequestResources = pgTable(
  "approval_request_resources",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    resourceUnitId: uuid("resource_unit_id")
      .notNull()
      .references(() => resourceUnits.id),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.resourceUnitId] }),
    check("approval_request_resources_time_order", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

export const resourceReservations = pgTable(
  "resource_reservations",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    resourceUnitId: uuid("resource_unit_id")
      .notNull()
      .references(() => resourceUnits.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    status: reservationStatus("status").notNull().default("HELD"),
    releasedAt: tz("released_at"),
    holdExpiresAt: tz("hold_expires_at"),
    confirmedAt: tz("confirmed_at"),
    releaseReason: text("release_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("reservations_event_idx").on(t.eventId),
    index("reservations_hold_expiry_idx").on(t.holdExpiresAt).where(sql`${t.status} = 'HELD'`),
    index("reservations_unit_window_idx").on(t.resourceUnitId, t.startsAt, t.endsAt),
    check("resource_reservations_time_order", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "resource_reservations_released_state",
      sql`(${t.status} in ('RELEASED','EXPIRED') and ${t.releasedAt} is not null) or ${t.status} in ('HELD','CONFIRMED')`,
    ),
    // Exclusion constraint is defined in SQL migration; Drizzle does not model EXCLUDE.
  ],
);

export const registrations = pgTable(
  "registrations",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: registrationStatus("status").notNull().default("APPLIED"),
    admissionModeSnapshot: admissionMode("admission_mode_snapshot").notNull(),
    eligibilitySnapshot: jsonb("eligibility_snapshot").notNull(),
    eventRevision: integer("event_revision").notNull(),
    queuePosition: integer("queue_position"),
    appliedAt: tz("applied_at").notNull().defaultNow(),
    confirmedAt: tz("confirmed_at"),
    cancelledAt: tz("cancelled_at"),
    rejectionReason: text("rejection_reason"),
    withdrawnBy: uuid("withdrawn_by").references(() => users.id),
    withdrawalReason: text("withdrawal_reason"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: tz("decided_at"),
    promotedFromWaitlist: boolean("promoted_from_waitlist").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("registrations_event_user_unique").on(t.eventId, t.userId),
    index("registrations_event_status_idx").on(t.eventId, t.status),
    index("registrations_waitlist_idx")
      .on(t.eventId, t.queuePosition)
      .where(sql`${t.status} = 'WAITLISTED'`),
    index("registrations_event_confirmed_idx").on(t.eventId).where(sql`${t.status} = 'CONFIRMED'`),
    check(
      "registrations_queue_position_positive",
      sql`${t.queuePosition} is null or ${t.queuePosition} > 0`,
    ),
  ],
);

export const registrationHistory = pgTable("registration_history", {
  id: id(),
  registrationId: uuid("registration_id")
    .notNull()
    .references(() => registrations.id, { onDelete: "cascade" }),
  fromStatus: registrationStatus("from_status"),
  toStatus: registrationStatus("to_status").notNull(),
  actorId: uuid("actor_id").references(() => users.id),
  reason: text("reason"),
  createdAt: createdAt(),
});

export const quizzes = pgTable(
  "quizzes",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .unique()
      .references(() => events.id, { onDelete: "cascade" }),
    mode: quizMode("mode").notNull(),
    status: quizStatus("status").notNull().default("DRAFT"),
    opensAt: tz("opens_at").notNull(),
    closesAt: tz("closes_at").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    passScore: numeric("pass_score", { precision: 5, scale: 2 }),
    maxAttempts: integer("max_attempts").notNull().default(1),
    shuffleQuestions: boolean("shuffle_questions").notNull().default(true),
    tieBreakPolicy: text("tie_break_policy").notNull().default("SCORE_DESC_THEN_SUBMITTED_AT_ASC"),
    instructions: text("instructions").notNull().default(""),
    /** Overrides the event capacity for seat allocation when set. */
    seats: integer("seats"),
    allocatedAt: tz("allocated_at"),
    allocationNote: text("allocation_note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("quizzes_time_order", sql`${t.closesAt} > ${t.opensAt}`),
    check("quizzes_duration_range", sql`${t.durationSeconds} between 30 and 14400`),
    check("quizzes_max_attempts_one", sql`${t.maxAttempts} = 1`),
    check("quizzes_pass_score_nonnegative", sql`${t.passScore} is null or ${t.passScore} >= 0`),
    check(
      "quizzes_first_qualified_requires_cutoff",
      sql`${t.mode} <> 'FIRST_QUALIFIED' or ${t.passScore} is not null`,
    ),
    check("quizzes_seats_positive", sql`${t.seats} is null or ${t.seats} >= 1`),
  ],
);

export const quizQuestions = pgTable(
  "quiz_questions",
  {
    id: id(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    options: jsonb("options").notNull(),
    correctOptionIndex: integer("correct_option_index").notNull(),
    points: numeric("points", { precision: 5, scale: 2 }).notNull().default("1"),
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("quiz_questions_quiz_position_unique").on(t.quizId, t.position),
    check("quiz_questions_correct_index_nonnegative", sql`${t.correctOptionIndex} >= 0`),
    check("quiz_questions_points_positive", sql`${t.points} > 0`),
    check("quiz_questions_position_positive", sql`${t.position} > 0`),
    check(
      "quiz_questions_options_array",
      sql`jsonb_typeof(${t.options}) = 'array' and jsonb_array_length(${t.options}) between 2 and 6`,
    ),
    check(
      "quiz_questions_correct_in_range",
      sql`${t.correctOptionIndex} < jsonb_array_length(${t.options})`,
    ),
  ],
);

export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: id(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: quizAttemptStatus("status").notNull().default("IN_PROGRESS"),
    answers: jsonb("answers").notNull().default({}),
    score: numeric("score", { precision: 7, scale: 2 }),
    percentScore: numeric("percent_score", { precision: 5, scale: 2 }),
    qualified: boolean("qualified"),
    rank: integer("rank"),
    allocatedStatus: registrationStatus("allocated_status"),
    startedAt: tz("started_at").notNull().defaultNow(),
    expiresAt: tz("expires_at").notNull(),
    submittedAt: tz("submitted_at"),
    clientSubmittedAt: tz("client_submitted_at"),
  },
  (t) => [
    uniqueIndex("quiz_attempts_quiz_user_unique").on(t.quizId, t.userId),
    index("quiz_attempts_leaderboard_idx")
      .on(t.quizId, t.percentScore, t.submittedAt)
      .where(sql`${t.status} = 'SUBMITTED'`),
    check("quiz_attempts_rank_positive", sql`${t.rank} is null or ${t.rank} >= 1`),
    check(
      "quiz_attempts_percent_range",
      sql`${t.percentScore} is null or (${t.percentScore} >= 0 and ${t.percentScore} <= 100)`,
    ),
  ],
);

export const quizSelectionBatches = pgTable(
  "quiz_selection_batches",
  {
    id: id(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    mode: quizMode("mode").notNull(),
    policySnapshot: jsonb("policy_snapshot").notNull(),
    selectedCount: integer("selected_count").notNull(),
    finalizedBy: uuid("finalized_by").references(() => users.id),
    finalizedAt: tz("finalized_at").notNull().defaultNow(),
  },
  (t) => [check("quiz_selection_batches_count", sql`${t.selectedCount} >= 0`)],
);

export const checkpoints = pgTable(
  "checkpoints",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Coordinator-chosen label. Any text: "Entry", "Attendance", "Lab 3", "xyz". */
    name: text("name").notNull(),
    qrType: qrType("qr_type").notNull(),
    /** Only set for COUNTED. ONE_TIME is 1; TOGGLE and UNLIMITED are uncapped. */
    maxUses: integer("max_uses"),
    validityMode: qrValidityMode("validity_mode").notNull(),
    startsAt: tz("starts_at"),
    endsAt: tz("ends_at"),
    /** DATE mode: one calendar day, interpreted in the campus timezone. */
    validOn: date("valid_on"),
    requiresIdCheck: boolean("requires_id_check").notNull().default(true),
    /** Applies in every validity mode, so a QR can always be paused at once. */
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("checkpoints_event_name_unique").on(t.eventId, sql`lower(${t.name})`),
    check(
      "checkpoints_validity_fields",
      sql`(${t.validityMode} = 'WINDOW' AND ${t.startsAt} IS NOT NULL AND ${t.endsAt} IS NOT NULL
             AND ${t.endsAt} > ${t.startsAt} AND ${t.validOn} IS NULL)
        OR (${t.validityMode} = 'DATE' AND ${t.validOn} IS NOT NULL
             AND ${t.startsAt} IS NULL AND ${t.endsAt} IS NULL)
        OR (${t.validityMode} = 'MANUAL' AND ${t.validOn} IS NULL
             AND ${t.startsAt} IS NULL AND ${t.endsAt} IS NULL)`,
    ),
    check(
      "checkpoints_type_max_uses",
      sql`(${t.qrType} = 'COUNTED' AND ${t.maxUses} IS NOT NULL AND ${t.maxUses} >= 1)
        OR (${t.qrType} <> 'COUNTED' AND ${t.maxUses} IS NULL)`,
    ),
  ],
);

export const passes = pgTable("passes", {
  id: id(),
  registrationId: uuid("registration_id")
    .notNull()
    .unique()
    .references(() => registrations.id, { onDelete: "cascade" }),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  revokedAt: tz("revoked_at"),
  createdAt: createdAt(),
});

export const qrNonces = pgTable("qr_nonces", {
  nonceHash: text("nonce_hash").primaryKey(),
  passId: uuid("pass_id")
    .notNull()
    .references(() => passes.id, { onDelete: "cascade" }),
  checkpointId: uuid("checkpoint_id")
    .notNull()
    .references(() => checkpoints.id, { onDelete: "cascade" }),
  expiresAt: tz("expires_at").notNull(),
  consumedAt: tz("consumed_at").notNull().defaultNow(),
});

export const redemptions = pgTable(
  "redemptions",
  {
    id: id(),
    passId: uuid("pass_id")
      .notNull()
      .references(() => passes.id, { onDelete: "cascade" }),
    checkpointId: uuid("checkpoint_id")
      .notNull()
      .references(() => checkpoints.id, { onDelete: "cascade" }),
    scannerId: uuid("scanner_id")
      .notNull()
      .references(() => users.id),
    /** 1-based ordinal of this use, bounded by the QR's limit when it has one. */
    useNumber: integer("use_number").notNull().default(1),
    /** Set only for TOGGLE QRs: which way this scan counted. */
    direction: qrDirection("direction"),
    clientScanId: uuid("client_scan_id"),
    capturedAt: tz("captured_at"),
    redeemedAt: tz("redeemed_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("redemptions_pass_checkpoint_use_unique").on(t.passId, t.checkpointId, t.useNumber),
    index("redemptions_checkpoint_time_idx").on(t.checkpointId, t.redeemedAt),
    uniqueIndex("redemptions_scanner_client_id_unique")
      .on(t.scannerId, t.clientScanId)
      .where(sql`${t.clientScanId} is not null`),
    check("redemptions_use_number_positive", sql`${t.useNumber} >= 1`),
  ],
);

export const scanLogs = pgTable(
  "scan_logs",
  {
    id: id(),
    passId: uuid("pass_id").references(() => passes.id),
    checkpointId: uuid("checkpoint_id").references(() => checkpoints.id),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    scannerId: uuid("scanner_id")
      .notNull()
      .references(() => users.id),
    result: scanResult("result").notNull(),
    reason: text("reason").notNull(),
    identityCheck: identityCheckResult("identity_check").notNull().default("NOT_REQUIRED"),
    nonceHash: text("nonce_hash"),
    /** Client-generated id for an offline-queued scan; makes sync idempotent. */
    clientScanId: uuid("client_scan_id"),
    capturedAt: tz("captured_at"),
    syncedOffline: boolean("synced_offline").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("scan_logs_checkpoint_time_idx").on(t.checkpointId, t.createdAt),
    index("scan_logs_event_time_idx").on(t.eventId, t.createdAt),
    uniqueIndex("scan_logs_scanner_client_id_unique")
      .on(t.scannerId, t.clientScanId)
      .where(sql`${t.clientScanId} is not null`),
    check(
      "scan_logs_offline_requires_capture",
      sql`not ${t.syncedOffline} or ${t.capturedAt} is not null`,
    ),
  ],
);

export const complaintLocations = pgTable(
  "complaint_locations",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    description: text("description"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    revokedAt: tz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("complaint_locations_event_label_unique").on(t.eventId, t.label),
    index("complaint_locations_event_idx").on(t.eventId),
  ],
);

export const complaints = pgTable(
  "complaints",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => complaintLocations.id),
    reportedBy: uuid("reported_by")
      .notNull()
      .references(() => users.id),
    category: complaintCategory("category").notNull(),
    description: text("description").notNull(),
    status: complaintStatus("status").notNull().default("OPEN"),
    assignedTo: uuid("assigned_to").references(() => users.id),
    resolvedAt: tz("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("complaints_event_status_idx").on(t.eventId, t.status),
    index("complaints_location_idx").on(t.locationId),
  ],
);

export const complaintUpdates = pgTable("complaint_updates", {
  id: id(),
  complaintId: uuid("complaint_id")
    .notNull()
    .references(() => complaints.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => users.id),
  fromStatus: complaintStatus("from_status"),
  toStatus: complaintStatus("to_status"),
  assignedTo: uuid("assigned_to").references(() => users.id),
  note: text("note"),
  createdAt: createdAt(),
});

export const announcements = pgTable(
  "announcements",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    audience: text("audience").notNull().default("REGISTERED"),
    isPinned: boolean("is_pinned").notNull().default(false),
    revokedAt: tz("revoked_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    publishedAt: tz("published_at").notNull().defaultNow(),
  },
  (t) => [
    index("announcements_event_time_idx").on(t.eventId, t.publishedAt),
    check("announcements_audience_valid", sql`${t.audience} in ('REGISTERED','ALL_VISIBLE')`),
  ],
);

export const announcementReads = pgTable(
  "announcement_reads",
  {
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: tz("read_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.announcementId, t.userId] }),
    index("announcement_reads_user_idx").on(t.userId, t.readAt),
  ],
);

/** One row per (outbox message, device): a retry can never double-notify. */
export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: id(),
    outboxId: uuid("outbox_id").references(() => notificationOutbox.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => notificationDevices.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id"),
    status: text("status").notNull().default("PENDING"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("push_deliveries_outbox_device_unique").on(t.outboxId, t.deviceId),
    index("push_deliveries_device_idx").on(t.deviceId, t.createdAt),
    check(
      "push_deliveries_status_valid",
      sql`${t.status} in ('PENDING','SENT','FAILED','SKIPPED')`,
    ),
  ],
);

export const notificationDevices = pgTable(
  "notification_devices",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expoPushToken: text("expo_push_token").notNull().unique(),
    platform: text("platform").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [check("notification_devices_platform", sql`${t.platform} in ('ios','android','web')`)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").notNull().default({}),
    readAt: tz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    clubId: uuid("club_id").references(() => clubs.id),
    eventId: uuid("event_id").references(() => events.id),
    beforeData: jsonb("before_data"),
    afterData: jsonb("after_data"),
    requestId: text("request_id"),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    index("audit_logs_event_idx").on(t.eventId, t.createdAt),
    index("audit_logs_actor_idx").on(t.actorId, t.createdAt),
  ],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    keyHash: text("key_hash").primaryKey(),
    count: integer("count").notNull(),
    expiresAt: tz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("rate_limit_buckets_expiry_idx").on(t.expiresAt),
    check("rate_limit_buckets_count_positive", sql`${t.count} > 0`),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    requestHash: text("request_hash").notNull(),
    /** Null while the original request is still running. */
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    completed: boolean("completed").notNull().default(false),
    expiresAt: tz("expires_at").notNull().default(sql`now() + interval '24 hours'`),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.scope] }),
    index("idempotency_keys_expiry_idx").on(t.expiresAt),
  ],
);

export const outboxStatus = pgEnum("outbox_status", ["PENDING", "SENT", "FAILED", "SKIPPED"]);

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: id(),
    kind: text("kind").notNull(),
    recipientUserId: uuid("recipient_user_id").references(() => users.id, { onDelete: "set null" }),
    recipientEmail: text("recipient_email").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload").notNull().default({}),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "cascade",
    }),
    status: outboxStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    nextAttemptAt: tz("next_attempt_at").notNull().defaultNow(),
    sentAt: tz("sent_at"),
  },
  (t) => [
    index("notification_outbox_dispatch_idx")
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} = 'PENDING'`),
    index("notification_outbox_event_idx").on(t.eventId, t.createdAt),
    check("notification_outbox_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "notification_outbox_email_lowercase",
      sql`${t.recipientEmail} = lower(${t.recipientEmail})`,
    ),
  ],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    job: text("job").notNull(),
    startedAt: tz("started_at").notNull().defaultNow(),
    finishedAt: tz("finished_at"),
    processed: integer("processed").notNull().default(0),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [
    index("job_runs_job_started_idx").on(t.job, t.startedAt),
    check("job_runs_processed_nonnegative", sql`${t.processed} >= 0`),
  ],
);

/**
 * Immutable post-event report snapshots. Regenerating creates a new sequence
 * number rather than editing an issued record; a database trigger enforces this.
 */
export const eventReports = pgTable(
  "event_reports",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    eventRevision: integer("event_revision").notNull(),
    sequence: integer("sequence").notNull(),
    generatedBy: uuid("generated_by")
      .notNull()
      .references(() => users.id),
    snapshot: jsonb("snapshot").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    fileId: uuid("file_id").references(() => files.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("event_reports_event_sequence_unique").on(t.eventId, t.sequence),
    index("event_reports_event_time_idx").on(t.eventId, t.createdAt),
    check("event_reports_sequence_positive", sql`${t.sequence} > 0`),
  ],
);
