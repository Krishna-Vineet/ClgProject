-- Convergence for databases that applied the earlier, wrong 0017_audit_fk_single.
-- Same end state as 0017_audit_event_unlinked; both are safe to run in any order.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT conname FROM pg_constraint
    WHERE contype = 'f' AND conrelid = 'audit_logs'::regclass
      AND confrelid = 'events'::regclass
  LOOP
    EXECUTE format('ALTER TABLE audit_logs DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;
