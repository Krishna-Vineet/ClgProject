import { env } from "../config/env";
import { runMaintenance } from "./maintenance";

/**
 * In-process maintenance timer. Disabled by default so serverless/preview hosts
 * are not kept alive by a background loop; enable JOBS_ENABLED=true on a
 * long-lived host (e.g. Render) or call POST /api/v1/admin/jobs/maintenance from cron.
 */
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startJobs(): void {
  if (!env.JOBS_ENABLED || timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await runMaintenance();
      const touched =
        (result.holds?.expired ?? 0) +
        (result.lifecycle?.started ?? 0) +
        (result.lifecycle?.completed ?? 0) +
        (result.outbox?.processed ?? 0);
      if (touched > 0) console.log(`[jobs] maintenance processed=${touched}`);
    } catch (err) {
      console.error("[jobs] maintenance failed", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, env.JOB_INTERVAL_SECONDS * 1000);
  console.log(`[jobs] maintenance every ${env.JOB_INTERVAL_SECONDS}s`);
}

export function stopJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
