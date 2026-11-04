-- 0007: access QRs are defined entirely by the coordinator.
--
-- The previous shape hardcoded a purpose (ENTRY / MEAL / LIBRARY …) with a
-- suggested use limit. Those were only examples, so the purpose is removed and
-- replaced with what the coordinator actually chooses:
--   * a free-form name,
--   * a type: one time, toggle in/out, a counted number of uses, or unlimited,
--   * a validity mode: between two times, on one date, or only while switched on.

CREATE TYPE qr_type AS ENUM ('ONE_TIME','TOGGLE','COUNTED','UNLIMITED');
CREATE TYPE qr_validity_mode AS ENUM ('WINDOW','DATE','MANUAL');
CREATE TYPE qr_direction AS ENUM ('IN','OUT');

ALTER TABLE checkpoints ADD COLUMN qr_type qr_type;
ALTER TABLE checkpoints ADD COLUMN validity_mode qr_validity_mode;
ALTER TABLE checkpoints ADD COLUMN valid_on date;

-- Carry existing rows across so nothing already configured is lost. The old
-- purpose told us the intent; maxUses told us the count.
UPDATE checkpoints SET
  qr_type = CASE
    WHEN max_uses IS NULL THEN 'UNLIMITED'::qr_type
    WHEN max_uses = 1 THEN 'ONE_TIME'::qr_type
    ELSE 'COUNTED'::qr_type
  END,
  validity_mode = 'WINDOW'::qr_validity_mode;

ALTER TABLE checkpoints ALTER COLUMN qr_type SET NOT NULL;
ALTER TABLE checkpoints ALTER COLUMN validity_mode SET NOT NULL;

-- The window is now optional: DATE and MANUAL rows have no clock bounds.
ALTER TABLE checkpoints ALTER COLUMN starts_at DROP NOT NULL;
ALTER TABLE checkpoints ALTER COLUMN ends_at DROP NOT NULL;

ALTER TABLE checkpoints DROP CONSTRAINT IF EXISTS checkpoints_time_order;
ALTER TABLE checkpoints DROP CONSTRAINT IF EXISTS checkpoints_max_uses_positive;
DROP INDEX IF EXISTS checkpoints_event_name_unique;

ALTER TABLE checkpoints DROP COLUMN purpose;
DROP TYPE IF EXISTS checkpoint_purpose;

-- Names stay unique per event, but case-insensitively: "Entry" and "entry"
-- should not both exist at one event.
CREATE UNIQUE INDEX checkpoints_event_name_unique
  ON checkpoints (event_id, lower(name));

-- Each validity mode must carry exactly the fields it needs, so a QR cannot be
-- saved in a state the scanner would not know how to evaluate.
ALTER TABLE checkpoints ADD CONSTRAINT checkpoints_validity_fields CHECK (
  (validity_mode = 'WINDOW' AND starts_at IS NOT NULL AND ends_at IS NOT NULL
     AND ends_at > starts_at AND valid_on IS NULL)
  OR (validity_mode = 'DATE' AND valid_on IS NOT NULL
     AND starts_at IS NULL AND ends_at IS NULL)
  OR (validity_mode = 'MANUAL' AND valid_on IS NULL
     AND starts_at IS NULL AND ends_at IS NULL)
);

-- Only COUNTED carries a number; ONE_TIME is always 1 and the other two uncapped.
ALTER TABLE checkpoints ADD CONSTRAINT checkpoints_type_max_uses CHECK (
  (qr_type = 'COUNTED' AND max_uses IS NOT NULL AND max_uses >= 1)
  OR (qr_type <> 'COUNTED' AND max_uses IS NULL)
);

-- A toggle QR records which way each scan counted.
ALTER TABLE redemptions ADD COLUMN direction qr_direction;

COMMENT ON COLUMN checkpoints.name IS
  'Coordinator-chosen label shown on the participant phone. Any text; unique per event, case-insensitive.';
COMMENT ON COLUMN checkpoints.qr_type IS
  'ONE_TIME, TOGGLE (alternating in/out), COUNTED (max_uses), or UNLIMITED.';
COMMENT ON COLUMN checkpoints.validity_mode IS
  'WINDOW (starts_at..ends_at), DATE (valid_on, campus timezone), or MANUAL (is_active only).';
