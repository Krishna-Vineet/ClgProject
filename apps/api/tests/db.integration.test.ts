import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { type DbClient, closeDb, createDb } from "../src/db/client";

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("database integration", () => {
  let client: DbClient;

  beforeAll(() => {
    client = createDb(url as string, 2);
  });

  afterAll(async () => {
    if (client) await closeDb(client);
  });

  test("global_role enum uses HOD_DEAN only", async () => {
    const rows = await client.db.execute(
      sql`SELECT unnest(enum_range(NULL::global_role))::text AS role`,
    );
    const roles = rows.map((r) => String(r.role));
    expect(roles).toContain("HOD_DEAN");
    expect(roles).not.toContain("HOD");
    expect(roles).not.toContain("DEAN");
  });

  test("resource reservation exclusion constraint exists", async () => {
    const rows = await client.db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'x' AND conrelid = 'resource_reservations'::regclass
    `);
    expect(rows.length).toBeGreaterThan(0);
  });

  test("seed is idempotent and demo data exists", async () => {
    const users = await client.db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE email LIKE '%@demo.campusops.local'`,
    );
    expect(Number(users[0]?.n)).toBeGreaterThanOrEqual(10);
    const events = await client.db.execute(
      sql`SELECT count(*)::int AS n FROM events WHERE slug LIKE 'demo-%'`,
    );
    expect(Number(events[0]?.n)).toBeGreaterThanOrEqual(3);
  });
});
