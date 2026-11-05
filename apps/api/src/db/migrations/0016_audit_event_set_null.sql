-- Intentionally empty.
--
-- This file briefly added an ON DELETE SET NULL foreign key from audit_logs to
-- events. That cannot work: audit_logs is append-only by trigger, so the SET NULL
-- action itself is refused. 0017_audit_event_unlinked.sql removes the constraint
-- instead. The file stays so that databases which already recorded this migration
-- and databases that never did converge on the same schema.
SELECT 1;
