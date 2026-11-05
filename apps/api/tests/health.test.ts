import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

describe("health routes", () => {
  test("live does not require database", async () => {
    const app = createApp();
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("ok");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("ready reports the truth: 200 only when the database can actually serve", async () => {
    const app = createApp();
    const res = await app.request("/health/ready");
    const body = (await res.json()) as { data: { status: string; checks?: { database: string } } };
    // The probe must never claim "ok" while it cannot serve. Either the check
    // passed and says so, or it failed and the status says so.
    if (res.status === 200) {
      expect(body.data.status).toBe("ok");
      expect(body.data.checks?.database).toBe("ok");
    } else {
      expect(res.status).toBe(503);
      expect(body.data.status).toBe("degraded");
    }
  });

  test("the readiness probe fails closed when the database is unreachable", async () => {
    const { closeDb, createDb } = await import("../src/db/client");
    const { probeDatabase } = await import("../src/modules/health/routes");
    // A port nothing listens on: connect_timeout turns this into a failure, and
    // a failure must read as "take me out of rotation", never as "ok".
    const bad = createDb("postgresql://nobody:nobody@127.0.0.1:1/none", 1);
    try {
      const probe = await probeDatabase(bad.sql);
      expect(probe.ok).toBe(false);
      expect(probe.check).toBe("unavailable");
    } finally {
      await closeDb(bad).catch(() => {});
    }
  });

  test("the readiness probe fails when the schema is a migration behind", async () => {
    const { closeDb, createDb } = await import("../src/db/client");
    const { probeDatabase } = await import("../src/modules/health/routes");
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return;
    const client = createDb(url, 1);
    try {
      // A reachable database with no application tables must not pass as ready.
      await client.sql.unsafe("create schema if not exists health_probe_empty");
      const empty = await probeDatabase({
        unsafe: (query: string) =>
          client.sql.unsafe(query.replace(/'public\.users'/, "'health_probe_empty.users'")),
      });
      expect(empty.ok).toBe(false);
      expect(empty.check).toBe("schema_out_of_date");
      await client.sql.unsafe("drop schema if exists health_probe_empty");
    } finally {
      await closeDb(client).catch(() => {});
    }
  });

  test("unknown route returns stable error", async () => {
    const app = createApp();
    const res = await app.request("/missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
