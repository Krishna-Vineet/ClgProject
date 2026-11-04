-- Phase 3: events, individual approvals, resources.
-- Additive only. Existing Phase 1/2 data is preserved.

-- =========================
-- Event lifecycle timestamps
-- =========================
ALTER TABLE events
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN job_description text,
  ADD COLUMN banner_file_id uuid REFERENCES files(id);

ALTER TABLE events
  ADD CONSTRAINT events_published_requires_timestamp
  CHECK (status NOT IN ('PUBLISHED','LIVE','COMPLETED') OR published_at IS NOT NULL);

UPDATE events SET published_at = COALESCE(published_at, created_at)
  WHERE status IN ('PUBLISHED','LIVE','COMPLETED') AND published_at IS NULL;
UPDATE events SET cancellation_reason = COALESCE(cancellation_reason, 'Cancelled before Phase 3 tracking.')
  WHERE status = 'CANCELLED' AND cancellation_reason IS NULL;

ALTER TABLE events
  ADD CONSTRAINT events_cancelled_requires_reason
  CHECK (status <> 'CANCELLED' OR cancellation_reason IS NOT NULL);

CREATE INDEX events_club_created_idx ON events(club_id, created_at DESC);

-- =========================
-- Revisions record what changed
-- =========================
ALTER TABLE event_revisions
  ADD COLUMN changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN note text;

-- =========================
-- Bundles: only one current bundle per event
-- =========================
ALTER TABLE approval_bundles
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN submitted_by uuid REFERENCES users(id);

CREATE UNIQUE INDEX approval_bundles_one_current_per_event
  ON approval_bundles(event_id) WHERE superseded_at IS NULL;

-- =========================
-- Individual requests
-- =========================
ALTER TABLE approval_requests
  ADD COLUMN decided_by uuid REFERENCES users(id),
  ADD COLUMN tier_entered_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN due_at timestamptz;

-- Exactly one ORGANIZE and at most one INVITE_OUTSIDERS request per bundle.
CREATE UNIQUE INDEX approval_requests_one_organize_per_bundle
  ON approval_requests(bundle_id) WHERE type = 'ORGANIZE';
CREATE UNIQUE INDEX approval_requests_one_outsider_per_bundle
  ON approval_requests(bundle_id) WHERE type = 'INVITE_OUTSIDERS';

CREATE INDEX approval_requests_tier_queue_idx
  ON approval_requests(current_tier, status, tier_entered_at)
  WHERE status = 'PENDING';

-- Backfill deciders for rows created before Phase 3 tracked them explicitly.
UPDATE approval_requests
  SET decided_by = COALESCE(decided_by, assigned_approver_id, created_by),
      decided_at = COALESCE(decided_at, updated_at, now())
  WHERE status IN ('APPROVED','REJECTED') AND (decided_by IS NULL OR decided_at IS NULL);

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_decided_state
  CHECK (
    (status IN ('APPROVED','REJECTED') AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
    OR status IN ('PENDING','CHANGES_REQUESTED','CANCELLED')
  );

-- =========================
-- Resource holds
-- =========================
ALTER TABLE resource_reservations
  ADD COLUMN hold_expires_at timestamptz,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN release_reason text;

CREATE INDEX reservations_hold_expiry_idx
  ON resource_reservations(hold_expires_at) WHERE status = 'HELD';
CREATE INDEX reservations_unit_window_idx
  ON resource_reservations(resource_unit_id, starts_at, ends_at);

UPDATE resource_reservations
  SET released_at = COALESCE(released_at, now())
  WHERE status IN ('RELEASED','EXPIRED') AND released_at IS NULL;

ALTER TABLE resource_reservations
  ADD CONSTRAINT resource_reservations_released_state
  CHECK (
    (status IN ('RELEASED','EXPIRED') AND released_at IS NOT NULL)
    OR status IN ('HELD','CONFIRMED')
  );

ALTER TABLE resources
  ADD CONSTRAINT resources_capacity_positive CHECK (capacity IS NULL OR capacity > 0);

CREATE INDEX resources_department_kind_idx ON resources(department_id, kind);
CREATE INDEX resource_units_resource_idx ON resource_units(resource_id);

-- =========================
-- Notification outbox
-- Email/push is dispatched after commit, never inside a business transaction.
-- =========================
CREATE TYPE outbox_status AS ENUM ('PENDING','SENT','FAILED','SKIPPED');

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  approval_request_id uuid REFERENCES approval_requests(id) ON DELETE CASCADE,
  status outbox_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK (attempts >= 0),
  CHECK (recipient_email = lower(recipient_email))
);

CREATE INDEX notification_outbox_dispatch_idx
  ON notification_outbox(status, next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX notification_outbox_event_idx ON notification_outbox(event_id, created_at);

-- =========================
-- Event operational jobs lock
-- Advisory locks are used for hold expiry sweeps; this table records job runs.
-- =========================
CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  processed integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (processed >= 0)
);

CREATE INDEX job_runs_job_started_idx ON job_runs(job, started_at DESC);
