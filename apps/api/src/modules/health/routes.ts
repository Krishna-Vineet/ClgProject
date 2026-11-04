import { IMPLEMENTATION_PHASE } from "@campusops/shared";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { log } from "../../utils/logger";
import { ok } from "../../utils/response";

export const healthRoutes = new Hono();

/**
 * The readiness question, answerable without the route: can this connection
 * actually serve a request? Exported so it can be tested against a real pool
 * pointed at an unreachable host, which is the only way to prove the 503.
 */
export async function probeDatabase(sql: {
  unsafe: (query: string) => Promise<unknown>;
}): Promise<{ ok: boolean; check: Check; detail?: string }> {
  try {
    const rows = (await sql.unsafe(
      "select 1 as ok, to_regclass('public.users') is not null as schema_ok",
    )) as Array<{ ok: number; schema_ok: boolean }>;
    if (rows[0]?.schema_ok !== true)
      return { ok: false, check: "schema_out_of_date", detail: "public.users is absent" };
    return { ok: true, check: "ok" };
  } catch (err) {
    return {
      ok: false,
      check: "unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

type Check = "ok" | "not_configured" | "unavailable" | "schema_out_of_date";

function body(status: "ok" | "degraded", database: Check, detail?: string) {
  return {
    status,
    service: "campusops-api",
    phase: IMPLEMENTATION_PHASE,
    timestamp: new Date().toISOString(),
    checks: { database },
    ...(detail ? { detail } : {}),
  };
}

/** Liveness only: the process is up and serving. A probe must not depend on the DB. */
healthRoutes.get("/live", (c) =>
  ok(c, {
    status: "ok",
    service: "campusops-api",
    phase: IMPLEMENTATION_PHASE,
    timestamp: new Date().toISOString(),
    checks: { database: "not_configured" },
  }),
);

/**
 * Readiness: can this instance actually serve traffic?
 *
 * The readiness probe exists so a platform can take a broken instance out of
 * rotation. A probe that answers 200 while the database is unreachable, or while
 * the schema is a migration behind, does the opposite: it keeps routing traffic
 * to an instance that will fail every request. This one checks the table the
 * application actually depends on and returns 503 when it cannot serve.
 */
healthRoutes.get("/ready", async (c) => {
  if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_POOLED) {
    return ok(c, body("degraded", "not_configured"), 503);
  }
  const { sql } = getDb();
  // `select 1` only proves the socket is open. A reachable database behind a
  // missing migration cannot serve requests either, so ask for the table.
  const probe = await probeDatabase(sql);
  if (!probe.ok) {
    log.warn("readiness_degraded", { check: probe.check, detail: probe.detail });
    return ok(c, body("degraded", probe.check, probe.detail), 503);
  }
  return ok(c, body("ok", "ok"));
});
