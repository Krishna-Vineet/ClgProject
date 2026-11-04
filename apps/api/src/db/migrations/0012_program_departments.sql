-- Programmes belong to a department, and a programme may spend its first N years
-- in a separate foundation department (for example a common first-year wing).
-- Both are configuration, never code-level rules.

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id),
  ADD COLUMN IF NOT EXISTS foundation_department_id uuid REFERENCES departments(id),
  ADD COLUMN IF NOT EXISTS foundation_years integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_years integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE programs ADD CONSTRAINT programs_foundation_years_valid
    CHECK (foundation_years >= 0 AND foundation_years <= duration_years);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE programs ADD CONSTRAINT programs_duration_years_valid
    CHECK (duration_years BETWEEN 1 AND 12);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS programs_department_idx ON programs (department_id);

ALTER TABLE student_profiles
  ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES programs(id),
  ADD COLUMN IF NOT EXISTS study_year integer;

DO $$ BEGIN
  ALTER TABLE student_profiles ADD CONSTRAINT student_study_year_valid
    CHECK (study_year IS NULL OR study_year BETWEEN 1 AND 12);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS student_profiles_program_idx ON student_profiles (program_id);
