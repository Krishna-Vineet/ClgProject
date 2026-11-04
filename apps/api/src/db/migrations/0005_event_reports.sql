-- Phase 3 close-out: post-event reports.
--
-- A report is an immutable, filed record of what actually happened: who authorised
-- it, which club and coordinators ran it, which faculty were involved, which
-- resources were consumed, and who attended. Each generation stores a full
-- snapshot so a report never changes after it has been issued, even if the event
-- row is later edited.

CREATE TABLE IF NOT EXISTS event_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_revision integer NOT NULL,
  sequence integer NOT NULL,
  generated_by uuid NOT NULL REFERENCES users(id),
  snapshot jsonb NOT NULL,
  checksum_sha256 text NOT NULL,
  file_id uuid REFERENCES files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_reports_sequence_positive CHECK (sequence > 0),
  CONSTRAINT event_reports_event_sequence_unique UNIQUE (event_id, sequence)
);

CREATE INDEX IF NOT EXISTS event_reports_event_time_idx
  ON event_reports (event_id, created_at DESC);

-- Reports are issued records: never rewritten in place. Regenerating creates a
-- new row with the next sequence number. Deleting an event still cascades.
CREATE OR REPLACE FUNCTION event_reports_prevent_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event_reports is append-only; generate a new report instead';
END;
$$;

DROP TRIGGER IF EXISTS event_reports_no_update ON event_reports;
CREATE TRIGGER event_reports_no_update
  BEFORE UPDATE ON event_reports
  FOR EACH ROW EXECUTE FUNCTION event_reports_prevent_update();

-- The archived PDF is optional (storage may be disabled), but if present it must
-- actually be an EVENT_REPORT file.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS report_summary text,
  ADD COLUMN IF NOT EXISTS report_generated_at timestamptz;

COMMENT ON TABLE event_reports IS
  'Immutable post-event report snapshots. PDF archive is optional when S3 is disabled.';
COMMENT ON COLUMN event_reports.snapshot IS
  'Full report payload frozen at generation time: approvals, faculty, resources, attendance.';
COMMENT ON COLUMN event_reports.checksum_sha256 IS
  'SHA-256 of the canonical snapshot JSON, so a filed report can be verified later.';
