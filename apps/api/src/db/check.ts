import postgres from "postgres";
import { migrationDatabaseUrl, readEnv } from "../config/env";

async function main() {
  const url = migrationDatabaseUrl(readEnv());
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const version = await sql`SELECT version() AS version`;
    const tables = await sql`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    const migrations = await sql`SELECT name FROM schema_migrations ORDER BY name`;
    const exclusion = await sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'x' AND conrelid = 'resource_reservations'::regclass`;
    const roles = await sql`
      SELECT unnest(enum_range(NULL::global_role))::text AS role`;
    const eventStatuses = await sql`
      SELECT unnest(enum_range(NULL::event_status))::text AS status`;
    const approvalTiers = await sql`
      SELECT unnest(enum_range(NULL::approval_tier))::text AS tier`;
    const partialIndexes = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'approval_bundles_one_current_per_event',
          'approval_requests_one_organize_per_bundle',
          'approval_requests_one_outsider_per_bundle',
          'reservations_hold_expiry_idx'
        )
      ORDER BY indexname`;
    const reportTriggers = await sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'event_reports'::regclass AND NOT tgisinternal
      ORDER BY tgname`;
    const reportConstraints = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'event_reports' AND indexname = 'event_reports_event_sequence_unique'`;
    const auditTriggers = await sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal
      ORDER BY tgname`;
    const reservationStates = await sql`
      SELECT status::text AS status, count(*)::int AS count
      FROM resource_reservations GROUP BY status ORDER BY status`;
    console.log(
      JSON.stringify(
        {
          version: version[0]?.version,
          publicTables: tables[0]?.count,
          migrations: migrations.map((m) => m.name),
          resourceExclusionConstraints: exclusion.map((c) => c.conname),
          globalRoles: roles.map((r) => r.role),
          eventStatuses: eventStatuses.map((r) => r.status),
          approvalTiers: approvalTiers.map((r) => r.tier),
          phase3Indexes: partialIndexes.map((r) => r.indexname),
          auditAppendOnlyTriggers: auditTriggers.map((r) => r.tgname),
          reportAppendOnlyTriggers: reportTriggers.map((r) => r.tgname),
          reportSequenceUnique: reportConstraints.map((r) => r.indexname),
          reservationStates,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
