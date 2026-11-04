-- Refresh-token families and versioned consent.
--
-- Reuse detection used to revoke every session a user had, so an innocent
-- expired tab that retried once would sign the same person out on their phone and
-- on the lab machine. A "family" is one sign-in chain: login starts a family and
-- each rotation keeps the id. A replayed token revokes only its own chain.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS family_id uuid;
UPDATE sessions SET family_id = id WHERE family_id IS NULL;
ALTER TABLE sessions ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions (family_id);

-- Consent needs a version, otherwise "the user agreed" cannot be dated against a
-- policy. Existing rows keep a null version: they were captured before any
-- policy existed, and pretending otherwise would be worse than saying so.
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_version text;

-- The right to be forgotten cannot mean erasing the institution's attendance
-- and complaint history, which other people's records depend on. A deletion
-- therefore anonymises the user row in place: identifiers are overwritten and
-- this timestamp marks the account as gone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymised_at timestamptz;

CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
CREATE INDEX IF NOT EXISTS users_account_type_idx ON users (account_type);
