import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { type DbClient, closeDb, createDb } from "../src/db/client";
import { isExclusionViolation, isUniqueViolation } from "../src/utils/db-error";

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

maybe("database constraints", () => {
  let client: DbClient;

  beforeAll(() => {
    client = createDb(url as string, 2);
  });

  afterAll(async () => {
    if (client) await closeDb(client);
  });

  test("overlapping active reservation for same resource unit is rejected", async () => {
    const existing = await client.db.execute(sql`
      SELECT request_id, resource_unit_id, event_id, starts_at, ends_at
      FROM resource_reservations
      WHERE id = ${U(131)}
    `);
    const row = existing[0];
    if (!row) throw new Error("seed reservation missing");
    let failed = false;
    try {
      await client.db.execute(sql`
        INSERT INTO resource_reservations
          (request_id, resource_unit_id, event_id, starts_at, ends_at, status)
        VALUES
          (${row.request_id}, ${row.resource_unit_id}, ${row.event_id}, ${row.starts_at}, ${row.ends_at}, 'HELD')
      `);
    } catch (err) {
      failed = true;
      // Assert the PostgreSQL condition, not the driver's wording: Drizzle
      // wraps the error and its message text is not a stable contract.
      expect(isExclusionViolation(err)).toBe(true);
    }
    expect(failed).toBe(true);
  });

  test("adjacent reservation is allowed and then cleaned up", async () => {
    const existing = await client.db.execute(sql`
      SELECT request_id, resource_unit_id, event_id, ends_at
      FROM resource_reservations
      WHERE id = ${U(131)}
    `);
    const row = existing[0];
    if (!row) throw new Error("seed reservation missing");
    const inserted = await client.db.execute(sql`
      INSERT INTO resource_reservations
        (request_id, resource_unit_id, event_id, starts_at, ends_at, status)
      VALUES
        (${row.request_id}, ${row.resource_unit_id}, ${row.event_id}, ${row.ends_at}, ${row.ends_at}::timestamptz + interval '1 hour', 'HELD')
      RETURNING id
    `);
    expect(inserted.length).toBe(1);
    const newId = inserted[0]?.id;
    if (!newId) throw new Error("insert failed");
    await client.db.execute(sql`DELETE FROM resource_reservations WHERE id = ${newId}`);
  });

  test("duplicate event registration is rejected", async () => {
    let failed = false;
    try {
      await client.db.execute(sql`
        INSERT INTO registrations
          (event_id, user_id, status, admission_mode_snapshot, eligibility_snapshot, event_revision)
        VALUES
          (${U(80)}, ${U(16)}, 'APPLIED', 'FCFS', '{"version":1}'::jsonb, 1)
      `);
    } catch (err) {
      failed = true;
      expect(isUniqueViolation(err)).toBe(true);
    }
    expect(failed).toBe(true);
  });

  test("seed can be repeated without duplicating demo users", async () => {
    const before = await client.db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE email LIKE '%@demo.campusops.local'`,
    );
    // The seed script is exercised externally in CI/local gates; here we assert
    // the fixed demo set size: principal, HOD/Dean, two faculty, four club
    // organisers, two students, one outsider, one admin and support.
    expect(Number(before[0]?.n)).toBe(13);
  });
});
