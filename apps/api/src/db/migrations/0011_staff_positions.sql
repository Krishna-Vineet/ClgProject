-- Staff directory position (HR label), separate from access roles.

DO $$ BEGIN
  CREATE TYPE staff_position AS ENUM ('HOD', 'DEAN', 'PROFESSOR', 'ASSISTANT_PROFESSOR', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS position staff_position NOT NULL DEFAULT 'OTHER';

UPDATE staff_profiles SET position = CASE
  WHEN designation ILIKE '%assistant professor%' THEN 'ASSISTANT_PROFESSOR'::staff_position
  WHEN designation ILIKE '%dean%' THEN 'DEAN'::staff_position
  WHEN designation ILIKE '%hod%' OR designation ILIKE '%head%' THEN 'HOD'::staff_position
  WHEN designation ILIKE '%professor%' THEN 'PROFESSOR'::staff_position
  ELSE 'OTHER'::staff_position
END
WHERE position = 'OTHER';

CREATE INDEX IF NOT EXISTS staff_profiles_position_idx ON staff_profiles (position);
CREATE INDEX IF NOT EXISTS staff_profiles_department_idx ON staff_profiles (department_id);
