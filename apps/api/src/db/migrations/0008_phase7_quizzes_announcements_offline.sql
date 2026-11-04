-- 0008: Phase 7 — the on-the-day machinery.
--
-- Adds what the earlier phases deliberately left as schema-only:
--   * quiz seat allocation in both modes (top-N, first-to-qualify),
--   * announcements with per-reader read state and push devices,
--   * offline-tolerant scanning (a scan captured without network is synced later
--     and must stay idempotent, and must never be counted twice),
--   * participant withdrawal and the waitlist promotion it triggers,
--   * organiser decisions on MANUAL applications.

-- ── Quizzes ────────────────────────────────────────────────────────────────
-- The quiz tables already exist. Allocation needs to be recorded once, with the
-- run preserved so a coordinator can explain every seat afterwards.
ALTER TABLE quizzes ADD COLUMN allocated_at timestamptz;
ALTER TABLE quizzes ADD COLUMN allocation_note text;
ALTER TABLE quizzes ADD COLUMN instructions text NOT NULL DEFAULT '';
ALTER TABLE quizzes ADD COLUMN seats integer;
ALTER TABLE quizzes ADD CONSTRAINT quizzes_seats_positive
  CHECK (seats IS NULL OR seats >= 1);

-- One allocation run per quiz. Re-running is refused, not silently repeated.
ALTER TABLE quiz_attempts ADD COLUMN percent_score numeric(5,2);
ALTER TABLE quiz_attempts ADD COLUMN qualified boolean;
ALTER TABLE quiz_attempts ADD COLUMN rank integer;
ALTER TABLE quiz_attempts ADD COLUMN allocated_status registration_status;
ALTER TABLE quiz_attempts ADD COLUMN client_submitted_at timestamptz;
ALTER TABLE quiz_attempts ADD CONSTRAINT quiz_attempts_rank_positive
  CHECK (rank IS NULL OR rank >= 1);
ALTER TABLE quiz_attempts ADD CONSTRAINT quiz_attempts_percent_range
  CHECK (percent_score IS NULL OR (percent_score >= 0 AND percent_score <= 100));

CREATE INDEX quiz_attempts_leaderboard_idx
  ON quiz_attempts (quiz_id, percent_score DESC, submitted_at ASC)
  WHERE status = 'SUBMITTED';

-- A question's options are stored as a JSON array of strings. Constrain the
-- shape here as well as in Zod so a bad write cannot corrupt scoring.
ALTER TABLE quiz_questions ADD CONSTRAINT quiz_questions_options_array
  CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6);
ALTER TABLE quiz_questions ADD CONSTRAINT quiz_questions_correct_in_range
  CHECK (correct_option_index < jsonb_array_length(options));

-- ── Announcements ──────────────────────────────────────────────────────────
ALTER TABLE announcements ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;
ALTER TABLE announcements ADD COLUMN revoked_at timestamptz;
ALTER TABLE announcements ADD CONSTRAINT announcements_audience_valid
  CHECK (audience IN ('REGISTERED','ALL_VISIBLE'));
CREATE INDEX announcements_event_time_idx ON announcements (event_id, published_at DESC);

CREATE TABLE announcement_reads (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX announcement_reads_user_idx ON announcement_reads (user_id, read_at DESC);

-- Push delivery is recorded per outbox row so a retry cannot double-notify.
CREATE TABLE push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid REFERENCES notification_outbox(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
  ticket_id text,
  status text NOT NULL DEFAULT 'PENDING',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_deliveries_status_valid
    CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  CONSTRAINT push_deliveries_outbox_device_unique UNIQUE (outbox_id, device_id)
);
CREATE INDEX push_deliveries_device_idx ON push_deliveries (device_id, created_at DESC);

-- ── Offline-tolerant scanning ──────────────────────────────────────────────
-- A scan captured offline carries a client-generated id. The unique index makes
-- the sync endpoint idempotent: replaying a queued batch changes nothing.
ALTER TABLE scan_logs ADD COLUMN client_scan_id uuid;
ALTER TABLE scan_logs ADD COLUMN captured_at timestamptz;
ALTER TABLE scan_logs ADD COLUMN synced_offline boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX scan_logs_scanner_client_id_unique
  ON scan_logs (scanner_id, client_scan_id) WHERE client_scan_id IS NOT NULL;
ALTER TABLE scan_logs ADD CONSTRAINT scan_logs_offline_requires_capture
  CHECK (NOT synced_offline OR captured_at IS NOT NULL);

ALTER TABLE redemptions ADD COLUMN client_scan_id uuid;
ALTER TABLE redemptions ADD COLUMN captured_at timestamptz;
CREATE UNIQUE INDEX redemptions_scanner_client_id_unique
  ON redemptions (scanner_id, client_scan_id) WHERE client_scan_id IS NOT NULL;

-- ── Withdrawal, waitlist promotion and application decisions ───────────────
ALTER TABLE registrations ADD COLUMN withdrawn_by uuid REFERENCES users(id);
ALTER TABLE registrations ADD COLUMN withdrawal_reason text;
ALTER TABLE registrations ADD COLUMN decided_by uuid REFERENCES users(id);
ALTER TABLE registrations ADD COLUMN decided_at timestamptz;
ALTER TABLE registrations ADD COLUMN promoted_from_waitlist boolean NOT NULL DEFAULT false;

-- Promoting a waitlisted participant must not overbook: the confirmed count is
-- checked under the same event row lock used by registration. This index keeps
-- that check and the queue ordering cheap under event-day load.
CREATE INDEX registrations_event_confirmed_idx
  ON registrations (event_id) WHERE status = 'CONFIRMED';

-- ── Report enrichment ──────────────────────────────────────────────────────
-- Reports stay append-only; the richer sections live inside the snapshot JSON.
-- Nothing to alter, but the checksum version is bumped in application code.
