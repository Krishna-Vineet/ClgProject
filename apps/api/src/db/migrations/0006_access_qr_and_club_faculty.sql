-- Phase 4 hardening: the access-QR model the college actually runs, and the
-- removal of two roles that do not exist in the institution.
--
-- 1. "Club faculty advisor" was a separate grant. It is replaced by an ordinary
--    club membership with clubRole = FACULTY, managed by HOD/Dean and Admin.
-- 2. "Scanning staff" was a separate person. Scanning is done by the event's own
--    coordinators and club faculty, so checkpoint_assignments is removed.
-- 3. A checkpoint could only ever be redeemed once per pass because of a unique
--    index. Real events need Entry (unlimited), Meal (once), Book Issue (three
--    times). Usage is now a bounded counter, not a uniqueness constraint.
--
-- Enum values are changed by swapping the type rather than ALTER TYPE ... ADD
-- VALUE, because a new enum value cannot be used in the transaction that added it
-- and each migration file runs inside one transaction.

-- ── 1. club_role gains FACULTY ───────────────────────────────────────────────
CREATE TYPE club_role_new AS ENUM ('LEAD', 'COORDINATOR', 'FACULTY');
ALTER TABLE club_memberships ALTER COLUMN club_role DROP DEFAULT;
ALTER TABLE club_memberships
  ALTER COLUMN club_role TYPE club_role_new USING club_role::text::club_role_new;
ALTER TABLE club_memberships ALTER COLUMN club_role SET DEFAULT 'COORDINATOR';
DROP TYPE club_role;
ALTER TYPE club_role_new RENAME TO club_role;

-- Carry every existing advisor across as a club faculty member, so no club loses
-- its faculty relationship and no historical report becomes unexplainable.
INSERT INTO club_memberships (club_id, user_id, club_role, is_active, added_by)
SELECT c.id, c.faculty_advisor_id, 'FACULTY', true, c.created_by
FROM clubs c
WHERE c.faculty_advisor_id IS NOT NULL
ON CONFLICT (club_id, user_id) DO UPDATE
  SET club_role = 'FACULTY', is_active = true;

ALTER TABLE clubs DROP COLUMN faculty_advisor_id;

-- ── 2. Scanning is an event-organiser action, not a separate assignment ──────
DROP TABLE IF EXISTS checkpoint_assignments;

-- ── 3. Checkpoint purposes that match a real one-day event ───────────────────
CREATE TYPE checkpoint_purpose_new AS ENUM
  ('ENTRY', 'EXIT', 'MEAL', 'LIBRARY', 'SESSION', 'CUSTOM');
ALTER TABLE checkpoints
  ALTER COLUMN purpose TYPE checkpoint_purpose_new
  USING (CASE purpose::text
           WHEN 'GATE' THEN 'ENTRY'
           WHEN 'HALL' THEN 'SESSION'
           ELSE purpose::text
         END)::checkpoint_purpose_new;
DROP TYPE checkpoint_purpose;
ALTER TYPE checkpoint_purpose_new RENAME TO checkpoint_purpose;

-- ── 4. Usage limits replace the SINGLE_USE / REENTRY switch ──────────────────
-- NULL means unlimited (entry and exit). A positive integer is the total number
-- of times one participant may use that checkpoint for the whole event.
ALTER TABLE checkpoints ADD COLUMN max_uses integer;
UPDATE checkpoints SET max_uses = CASE mode::text WHEN 'REENTRY' THEN NULL ELSE 1 END;
ALTER TABLE checkpoints DROP COLUMN mode;
DROP TYPE checkpoint_mode;
ALTER TABLE checkpoints
  ADD CONSTRAINT checkpoints_max_uses_positive CHECK (max_uses IS NULL OR max_uses >= 1);

-- ── 5. Redemptions become a counted ledger ───────────────────────────────────
-- The original schema enforced ONE redemption per pass per checkpoint. The new
-- model counts total uses, so that rule must go: entry/exit are unlimited and a
-- book-issue counter allows three. It exists both as a named index and as an
-- inline UNIQUE constraint depending on which migration created the table, so
-- drop both spellings.
DROP INDEX IF EXISTS redemptions_pass_checkpoint_unique;
ALTER TABLE redemptions DROP CONSTRAINT IF EXISTS redemptions_pass_id_checkpoint_id_key;
ALTER TABLE redemptions ADD COLUMN use_number integer NOT NULL DEFAULT 1;
ALTER TABLE redemptions
  ADD CONSTRAINT redemptions_use_number_positive CHECK (use_number >= 1);
-- Still idempotent: the same use of the same checkpoint cannot be written twice,
-- but a second and third use are now legal where max_uses allows them.
CREATE UNIQUE INDEX redemptions_pass_checkpoint_use_unique
  ON redemptions (pass_id, checkpoint_id, use_number);
CREATE INDEX redemptions_checkpoint_time_idx ON redemptions (checkpoint_id, redeemed_at);

-- ── 6. Complaint QRs are handed out per location, so they need a stable token ─
-- The row id is already an unguessable uuid; a separate public token would be
-- redundant. What was missing is a way to close a location without deleting the
-- complaints raised against it, which revoked_at already provides.
CREATE INDEX complaint_locations_event_idx ON complaint_locations (event_id);
CREATE INDEX complaints_location_idx ON complaints (location_id);

-- ── 7. Scan logs are read per event in the portal ────────────────────────────
-- Denormalised from the checkpoint so an event's full scan history (including
-- codes that matched no pass) can be listed without a join, and so a denied scan
-- still records which event it happened at.
ALTER TABLE scan_logs ADD COLUMN event_id uuid REFERENCES events(id) ON DELETE CASCADE;
UPDATE scan_logs sl SET event_id = c.event_id FROM checkpoints c WHERE sl.checkpoint_id = c.id;
CREATE INDEX scan_logs_event_time_idx ON scan_logs (event_id, created_at);
