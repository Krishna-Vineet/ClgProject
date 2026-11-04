-- Phase 2 close-out: OTP attempts, private storage metadata, distributed rate limits,
-- idempotency, and schema-scope hardening found by the senior critic audit.

ALTER TABLE auth_tokens
  ADD COLUMN otp_hash text,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN last_sent_at timestamptz,
  ADD COLUMN delivery_status text NOT NULL DEFAULT 'PENDING',
  ADD CONSTRAINT auth_tokens_attempts_range CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10),
  ADD CONSTRAINT auth_tokens_delivery_status CHECK (delivery_status IN ('PENDING','SENT','FAILED','DEMO'));

ALTER TABLE files
  ADD COLUMN storage_provider text NOT NULL DEFAULT 's3',
  ADD COLUMN bucket text,
  ADD COLUMN checksum_sha256 text,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT files_size_nonnegative CHECK (size_bytes >= 0),
  ADD CONSTRAINT files_storage_provider CHECK (storage_provider IN ('s3')),
  ADD CONSTRAINT files_ready_requires_bucket CHECK (status <> 'READY' OR bucket IS NOT NULL);

ALTER TABLE student_profiles
  ADD CONSTRAINT student_verification_pair CHECK (
    (verified_at IS NULL AND verified_by IS NULL) OR
    (verified_at IS NOT NULL AND verified_by IS NOT NULL)
  );

ALTER TABLE notification_devices
  ADD CONSTRAINT notification_devices_platform CHECK (platform IN ('ios','android','web'));

ALTER TABLE quiz_selection_batches
  ADD CONSTRAINT quiz_selection_batches_count CHECK (selected_count >= 0);

CREATE TABLE rate_limit_buckets (
  key_hash text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_buckets_expiry_idx ON rate_limit_buckets(expires_at);

CREATE TABLE idempotency_keys (
  key text NOT NULL,
  scope text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, scope)
);

-- Audit logs are append-only at the database boundary.
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

ALTER TYPE file_purpose ADD VALUE IF NOT EXISTS 'EVENT_REPORT';
ALTER TYPE file_purpose ADD VALUE IF NOT EXISTS 'ATTENDEE_EXPORT';
ALTER TYPE file_purpose ADD VALUE IF NOT EXISTS 'COMPLAINT_ATTACHMENT';
