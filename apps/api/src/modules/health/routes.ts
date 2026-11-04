import { IMPLEMENTATION_PHASE } from "@campusops/shared";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { ok } from "../../utils/response";

export const healthRoutes = new Hono();

healthRoutes.get("/live", (c) =>
  ok(c, {
    status: "ok",
    service: "campusops-api",
    phase: IMPLEMENTATION_PHASE,
    timestamp: new Date().toISOString(),
    checks: { database: "not_configured" },
  }),
);

healthRoutes.get("/ready", async (c) => {
  if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_POOLED) {
    return ok(
      c,
      {
        status: "degraded",
        service: "campusops-api",
        phase: IMPLEMENTATION_PHASE,
        timestamp: new Date().toISOString(),
        checks: { database: "not_configured" },
      },
      503,
    );
  }
  try {
    const { sql } = getDb();
    await sql`SELECT 1 AS ok`;
    return ok(c, {
      status: "ok",
      service: "campusops-api",
      phase: IMPLEMENTATION_PHASE,
      timestamp: new Date().toISOString(),
      checks: { database: "ok" },
    });
  } catch {
    return ok(
      c,
      {
        status: "degraded",
        service: "campusops-api",
        phase: IMPLEMENTATION_PHASE,
        timestamp: new Date().toISOString(),
        checks: { database: "unavailable" },
      },
      503,
    );
  }
});
