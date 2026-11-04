import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { env } from "../../config/env";
import { runMaintenance } from "../../jobs/maintenance";
import { ApiError } from "../../utils/api-error";
import { ok } from "../../utils/response";

function tokenMatches(given: string): boolean {
  const expected = env.JOB_RUN_TOKEN;
  if (!expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Optional scheduler entry point. It does not require a user session, so a
 * host's cron (if it has one) can call it with a long-lived job token. The app
 * also runs the same pass opportunistically, so this route is never required.
 */
export const jobRoutes = new Hono();

jobRoutes.post("/maintenance", async (c) => {
  if (!env.JOB_RUN_TOKEN)
    throw new ApiError("NOT_FOUND", "Scheduled maintenance is not configured on this host.");
  const header =
    c.req.header("x-job-token") ?? c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!header || !tokenMatches(header))
    throw new ApiError("UNAUTHENTICATED", "A valid job token is required.");
  return ok(c, await runMaintenance());
});
