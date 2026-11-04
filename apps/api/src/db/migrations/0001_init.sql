-- CampusOps initial schema
-- Generated from approved blueprint; HOD/Dean is one role category: HOD_DEAN.
-- CampusOps PostgreSQL schema DRAFT v1
-- Planning artifact only. Review before converting to migrations.
-- Requires PostgreSQL 15+ and btree_gist. Neon supports required features.
-- All timestamps are timestamptz. Application display timezone: Asia/Kolkata.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================
-- Enums
-- =========================
CREATE TYPE account_type AS ENUM ('COLLEGE_STUDENT','OUTSIDER_STUDENT','STAFF');
CREATE TYPE account_status AS ENUM ('PENDING_EMAIL','PENDING_VERIFICATION','ACTIVE','REJECTED','SUSPENDED');
CREATE TYPE global_role AS ENUM ('ADMIN','FACULTY','HOD_DEAN','SUPPORT');
CREATE TYPE role_scope AS ENUM ('GLOBAL','DEPARTMENT');
CREATE TYPE club_role AS ENUM ('LEAD','COORDINATOR');
CREATE TYPE event_template AS ENUM ('WORKSHOP','SEMINAR','WEBINAR','HACKATHON','PLACEMENT_DRIVE','SPORTS','CUSTOM');
CREATE TYPE event_status AS ENUM ('DRAFT','PENDING_APPROVALS','READY','PUBLISHED','LIVE','COMPLETED','CANCELLED');
CREATE TYPE event_audience AS ENUM ('COLLEGE_ONLY','OUTSIDERS_ALLOWED','INVITED_ONLY');
CREATE TYPE admission_mode AS ENUM ('FCFS','MANUAL','QUIZ_TOP_N','QUIZ_FIRST_QUALIFIED');
CREATE TYPE approval_type AS ENUM ('ORGANIZE','INVITE_OUTSIDERS','RESOURCE_USE','CUSTOM');
CREATE TYPE approval_tier AS ENUM ('FACULTY','SENIOR','ADMIN');
CREATE TYPE approval_status AS ENUM ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED','CANCELLED');
CREATE TYPE approval_action_type AS ENUM ('SUBMIT','APPROVE','REJECT','ESCALATE','REQUEST_CHANGES','RESUBMIT','REASSIGN','CANCEL');
CREATE TYPE resource_kind AS ENUM ('VENUE','LAB','EQUIPMENT','OTHER');
CREATE TYPE resource_status AS ENUM ('ACTIVE','MAINTENANCE','RETIRED');
CREATE TYPE reservation_status AS ENUM ('HELD','CONFIRMED','RELEASED','EXPIRED');
CREATE TYPE registration_status AS ENUM ('APPLIED','CONFIRMED','WAITLISTED','REJECTED','CANCELLED');
CREATE TYPE checkpoint_purpose AS ENUM ('GATE','HALL','MEAL','LIBRARY','CUSTOM');
CREATE TYPE checkpoint_mode AS ENUM ('SINGLE_USE','REENTRY');
CREATE TYPE scan_result AS ENUM ('GRANTED','DENIED');
CREATE TYPE identity_check_result AS ENUM ('MATCH','MISMATCH','NOT_REQUIRED');
CREATE TYPE complaint_category AS ENUM ('POWER','WIFI','EQUIPMENT','VENUE','SAFETY','OTHER');
CREATE TYPE complaint_status AS ENUM ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED');
CREATE TYPE quiz_mode AS ENUM ('TOP_N','FIRST_QUALIFIED');
CREATE TYPE quiz_status AS ENUM ('DRAFT','PUBLISHED','CLOSED');
CREATE TYPE quiz_attempt_status AS ENUM ('IN_PROGRESS','SUBMITTED','EXPIRED');
CREATE TYPE file_purpose AS ENUM ('PROFILE_PHOTO','COLLEGE_ID_PROOF','EVENT_BANNER');
CREATE TYPE file_status AS ENUM ('PENDING','READY','REJECTED','DELETED');

-- =========================
-- Identity and access
-- =========================
CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  account_type account_type NOT NULL,
  status account_status NOT NULL DEFAULT 'PENDING_EMAIL',
  email_verified_at timestamptz,
  full_name text NOT NULL,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_unique ON users(email);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose file_purpose NOT NULL,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  status file_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE student_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  student_kind account_type NOT NULL CHECK (student_kind IN ('COLLEGE_STUDENT','OUTSIDER_STUDENT')),
  institution_name text NOT NULL,
  roll_number text,
  department_id uuid REFERENCES departments(id),
  program text,
  graduation_year integer CHECK (graduation_year BETWEEN 2000 AND 2100),
  college_id_number text,
  photo_file_id uuid REFERENCES files(id),
  id_proof_file_id uuid REFERENCES files(id),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  rejection_reason text,
  profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT college_profile_requires_department CHECK (
    student_kind <> 'COLLEGE_STUDENT' OR department_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX student_roll_unique ON student_profiles(institution_name, roll_number) WHERE roll_number IS NOT NULL;

CREATE TABLE staff_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code text UNIQUE,
  department_id uuid REFERENCES departments(id),
  designation text NOT NULL,
  photo_file_id uuid REFERENCES files(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  device_label text,
  ip_hash text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role global_role NOT NULL,
  scope_type role_scope NOT NULL,
  department_id uuid REFERENCES departments(id),
  granted_by uuid REFERENCES users(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_scope_matches_department CHECK (
    (scope_type = 'GLOBAL' AND department_id IS NULL) OR
    (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX role_assignment_unique ON role_assignments(user_id, role, scope_type, COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- =========================
-- Clubs and events
-- =========================
CREATE TABLE clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  description text,
  department_id uuid REFERENCES departments(id),
  faculty_advisor_id uuid REFERENCES users(id),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE club_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_role club_role NOT NULL DEFAULT 'COORDINATOR',
  is_active boolean NOT NULL DEFAULT true,
  added_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(club_id, user_id)
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES clubs(id),
  created_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  template event_template NOT NULL DEFAULT 'CUSTOM',
  status event_status NOT NULL DEFAULT 'DRAFT',
  audience event_audience NOT NULL DEFAULT 'COLLEGE_ONLY',
  admission_mode admission_mode NOT NULL DEFAULT 'FCFS',
  eligibility_policy jsonb NOT NULL DEFAULT '{"version":1}'::jsonb,
  capacity integer NOT NULL CHECK (capacity > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  registration_opens_at timestamptz NOT NULL,
  registration_closes_at timestamptz NOT NULL,
  venue_summary text,
  online_meeting_url text,
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  published_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (registration_closes_at > registration_opens_at),
  CHECK (registration_closes_at <= starts_at)
);
CREATE INDEX events_club_status_idx ON events(club_id, status);
CREATE INDEX events_public_time_idx ON events(status, starts_at);

CREATE TABLE event_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, revision)
);

CREATE TABLE event_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  user_id uuid REFERENCES users(id),
  invited_by uuid NOT NULL REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, email)
);

-- =========================
-- Approvals and resources
-- =========================
CREATE TABLE approval_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_revision_id uuid NOT NULL REFERENCES event_revisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, event_revision_id)
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id uuid NOT NULL REFERENCES approval_bundles(id) ON DELETE CASCADE,
  type approval_type NOT NULL,
  title text NOT NULL,
  description text,
  is_required boolean NOT NULL DEFAULT true,
  current_tier approval_tier NOT NULL DEFAULT 'FACULTY',
  assigned_approver_id uuid REFERENCES users(id),
  status approval_status NOT NULL DEFAULT 'PENDING',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_requests_inbox_idx ON approval_requests(assigned_approver_id, status, current_tier);

CREATE TABLE approval_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  action approval_action_type NOT NULL,
  from_tier approval_tier,
  to_tier approval_tier,
  from_status approval_status,
  to_status approval_status,
  comment text,
  request_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_actions_request_idx ON approval_actions(request_id, created_at);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid REFERENCES departments(id),
  kind resource_kind NOT NULL,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  description text,
  status resource_status NOT NULL DEFAULT 'ACTIVE',
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resource_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  label text NOT NULL,
  code text NOT NULL UNIQUE,
  status resource_status NOT NULL DEFAULT 'ACTIVE',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(resource_id, label)
);

CREATE TABLE approval_request_resources (
  request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  resource_unit_id uuid NOT NULL REFERENCES resource_units(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  PRIMARY KEY(request_id, resource_unit_id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE resource_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  resource_unit_id uuid NOT NULL REFERENCES resource_units(id),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status reservation_status NOT NULL DEFAULT 'HELD',
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  EXCLUDE USING gist (
    resource_unit_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('HELD','CONFIRMED'))
);
CREATE INDEX reservations_event_idx ON resource_reservations(event_id);

-- =========================
-- Registration and quizzes
-- =========================
CREATE TABLE registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status registration_status NOT NULL DEFAULT 'APPLIED',
  admission_mode_snapshot admission_mode NOT NULL,
  eligibility_snapshot jsonb NOT NULL,
  event_revision integer NOT NULL,
  queue_position integer CHECK (queue_position IS NULL OR queue_position > 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  rejection_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, user_id)
);
CREATE INDEX registrations_event_status_idx ON registrations(event_id, status);
CREATE INDEX registrations_waitlist_idx ON registrations(event_id, queue_position) WHERE status = 'WAITLISTED';

CREATE TABLE registration_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  from_status registration_status,
  to_status registration_status NOT NULL,
  actor_id uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  mode quiz_mode NOT NULL,
  status quiz_status NOT NULL DEFAULT 'DRAFT',
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 30 AND 14400),
  pass_score numeric(5,2) CHECK (pass_score >= 0),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts = 1),
  shuffle_questions boolean NOT NULL DEFAULT true,
  tie_break_policy text NOT NULL DEFAULT 'SCORE_DESC_THEN_SUBMITTED_AT_ASC',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at),
  CHECK (mode <> 'FIRST_QUALIFIED' OR pass_score IS NOT NULL)
);

CREATE TABLE quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  prompt text NOT NULL,
  options jsonb NOT NULL,
  correct_option_index integer NOT NULL CHECK (correct_option_index >= 0),
  points numeric(5,2) NOT NULL DEFAULT 1 CHECK (points > 0),
  position integer NOT NULL CHECK (position > 0),
  UNIQUE(quiz_id, position)
);

CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status quiz_attempt_status NOT NULL DEFAULT 'IN_PROGRESS',
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  score numeric(7,2),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  UNIQUE(quiz_id, user_id)
);

CREATE TABLE quiz_selection_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  mode quiz_mode NOT NULL,
  policy_snapshot jsonb NOT NULL,
  selected_count integer NOT NULL CHECK (selected_count >= 0),
  finalized_by uuid REFERENCES users(id),
  finalized_at timestamptz NOT NULL DEFAULT now()
);

-- =========================
-- Passes and checkpoints
-- =========================
CREATE TABLE checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose checkpoint_purpose NOT NULL,
  mode checkpoint_mode NOT NULL DEFAULT 'SINGLE_USE',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  requires_id_check boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE(event_id, name)
);

CREATE TABLE checkpoint_assignments (
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by uuid NOT NULL REFERENCES users(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(checkpoint_id, user_id)
);

CREATE TABLE passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qr_nonces (
  nonce_hash text PRIMARY KEY,
  pass_id uuid NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  scanner_id uuid NOT NULL REFERENCES users(id),
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(pass_id, checkpoint_id)
);

CREATE TABLE scan_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid REFERENCES passes(id),
  checkpoint_id uuid REFERENCES checkpoints(id),
  scanner_id uuid NOT NULL REFERENCES users(id),
  result scan_result NOT NULL,
  reason text NOT NULL,
  identity_check identity_check_result NOT NULL DEFAULT 'NOT_REQUIRED',
  nonce_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_logs_checkpoint_time_idx ON scan_logs(checkpoint_id, created_at DESC);

-- =========================
-- Complaints
-- =========================
CREATE TABLE complaint_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label text NOT NULL,
  description text,
  created_by uuid NOT NULL REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, label)
);

CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  location_id uuid REFERENCES complaint_locations(id),
  reported_by uuid NOT NULL REFERENCES users(id),
  category complaint_category NOT NULL,
  description text NOT NULL,
  status complaint_status NOT NULL DEFAULT 'OPEN',
  assigned_to uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaints_event_status_idx ON complaints(event_id, status);

CREATE TABLE complaint_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  from_status complaint_status,
  to_status complaint_status,
  assigned_to uuid REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================
-- Communication and audit
-- =========================
CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL DEFAULT 'REGISTERED',
  created_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios','android','web')),
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id)
);
CREATE INDEX chat_messages_event_idx ON chat_messages(event_id, created_at DESC);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  club_id uuid REFERENCES clubs(id),
  event_id uuid REFERENCES events(id),
  before_data jsonb,
  after_data jsonb,
  request_id text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_event_idx ON audit_logs(event_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_id, created_at DESC);

