import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { migrationDatabaseUrl, readEnv } from "../config/env";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
/** Arbitrary, stable Postgres advisory-lock key for the migration runner. */
const MIGRATION_LOCK_KEY = 884211;

export type MigrationResult = { applied: string[]; skipped: number };

/**
 * Apply every migration that is not yet recorded. Safe to run on every boot:
 * applied files are skipped, and an advisory lock stops two API instances from
 * racing each other during a rolling deploy.
 */
export async function runMigrations({
  quiet = false,
}: { quiet?: boolean } = {}): Promise<MigrationResult> {
  const url = migrationDatabaseUrl(readEnv());
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const say = (line: string) => {
    if (!quiet) console.log(line);
  };
  let locked = false;
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    locked = true;
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    let skipped = 0;
    for (const file of files) {
      const existing = await sql`SELECT name FROM schema_migrations WHERE name = ${file}`;
      if (existing.length > 0) {
        skipped += 1;
        say(`skip ${file}`);
        continue;
      }
      const content = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
      say(`applied ${file}`);
    }
    say(`migrations complete (${applied.length} applied, ${skipped} already present)`);
    return { applied, skipped };
  } finally {
    try {
      if (locked) await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    } catch {
      // Releasing the lock is best effort; closing the session releases it too.
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

async function main() {
  await runMigrations();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
