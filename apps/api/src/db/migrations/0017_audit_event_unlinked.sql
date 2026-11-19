-- The audit trail references events by *value*, not by foreign key.
--
-- Two attempts to make the link survivable both failed the same way:
--   * NO ACTION refused to delete a draft because its audit row pointed at it.
--   * ON DELETE SET NULL tried to UPDATE the audit row, and audit_logs is
--     append-only by trigger — so the delete was refused from the other side.
--
-- The constraint was the mistake, not the behaviour. An audit table must outlive
-- every row it talks about, and `entity_type` + `entity_id` is already the
-- reference it uses for everything else. `event_id` stays as a plain uuid: it
-- still answers "which event was this about", and it no longer has the power to
-- prevent that event from being removed.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'audit_logs'::regclass
      AND confrelid = 'events'::regclass
  LOOP
    EXECUTE format('ALTER TABLE audit_logs DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;

COMMENT ON COLUMN audit_logs.event_id IS
  'Historical reference to an event by id. Deliberately not a foreign key: the audit trail outlives what it records.';
