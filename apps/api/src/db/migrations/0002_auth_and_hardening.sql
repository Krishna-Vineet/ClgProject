-- Phase 2 auth token storage + Phase 1 audit hardening

CREATE TYPE auth_token_purpose AS ENUM ('EMAIL_VERIFICATION','PASSWORD_RESET','STAFF_SETUP');

ALTER TABLE users
  ADD COLUMN password_updated_at timestamptz;

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose auth_token_purpose NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_tokens_user_idx ON auth_tokens(user_id, purpose);

ALTER TABLE role_assignments
  ADD CONSTRAINT role_assignments_admin_global
  CHECK (role <> 'ADMIN' OR scope_type = 'GLOBAL');

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_faculty_assignee
  CHECK (current_tier <> 'FACULTY' OR assigned_approver_id IS NOT NULL);
