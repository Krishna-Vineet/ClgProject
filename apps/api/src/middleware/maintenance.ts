import { createMiddleware } from "hono/factory";
import { env } from "../config/env";
import { runMaintenance } from "../jobs/maintenance";
import { log } from "../utils/logger";

let running = false;
let lastStartedAt = 0;

/**
 * Free hosts sleep and cannot run a two-minute cron. Instead, ordinary API
 * traffic nudges the maintenance pass when it is due. The work is idempotent,
 * takes an advisory lock, and is skipped entirely when a request arrives while
 * another pass is still running.
 */
export function maintenanceTick(force = false): void {
  if (process.env.NODE_ENV === "test" || !env.MAINTENANCE_ON_REQUEST) return;
  const now = Date.now();
  if (running) return;
  if (!force && now - lastStartedAt < env.MAINTENANCE_INTERVAL_SECONDS * 1000) return;
  running = true;
  lastStartedAt = now;
  setTimeout(() => {
    runMaintenance()
      .then((result) => {
        const touched =
          (result.holds?.expired ?? 0) +
          (result.lifecycle?.started ?? 0) +
          (result.lifecycle?.completed ?? 0) +
          (result.outbox?.processed ?? 0);
        if (touched > 0) log.info("maintenance_tick", { processed: touched });
      })
      .catch((err) => log.warn("maintenance_tick_failed", { error: String(err) }))
      .finally(() => {
        running = false;
      });
  }, 0);
}

export const opportunisticMaintenance = createMiddleware(async (_c, next) => {
  await next();
  maintenanceTick();
});
