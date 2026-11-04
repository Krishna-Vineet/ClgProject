-- Production hardening: safe idempotency reservation, phone verification
-- timestamps, consent capture, and removal of the never-used chat table.

ALTER TABLE idempotency_keys ALTER COLUMN response_status DROP NOT NULL;
ALTER TABLE idempotency_keys ALTER COLUMN response_body DROP NOT NULL;
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS completed boolean NOT NULL DEFAULT false;
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours');
UPDATE idempotency_keys SET completed = true WHERE response_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_accepted_at timestamptz;

DROP TABLE IF EXISTS chat_messages;
