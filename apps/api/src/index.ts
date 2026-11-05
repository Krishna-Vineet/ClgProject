import { createApp } from "./app";
import { env } from "./config/env";
import { closeDb, getDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { startJobs, stopJobs } from "./jobs";
import { maintenanceTick } from "./middleware/maintenance";
import { log } from "./utils/logger";

const app = createApp();

// Bring the schema up to date before serving. The runner is idempotent and
// advisory-locked, so restarting an already-migrated database is cheap.
//
// A failed migration used to `process.exit(1)`. On a free host that means a
// crash loop: the platform restarts, the database is still waking up, and the
// service never comes back — when the honest state is "degraded but answering",
// with /health/ready reporting 503 until the database arrives. Exit only when a
// supervisor is actually there to act on it (outside production).
if (env.AUTO_MIGRATE) {
  if (env.DATABASE_URL || env.DATABASE_URL_POOLED || env.DATABASE_DIRECT_URL) {
    try {
      const { applied, skipped } = await runMigrations({ quiet: true });
      log.info("database_migrations_checked", {
        applied: applied.length,
        alreadyPresent: skipped,
        files: applied,
      });
    } catch (err) {
      log.error("database_migration_failed", {
        error: err instanceof Error ? err.message : String(err),
        cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined,
        fix: "Check the database URL and run `bun run db:migrate` once from the repository root.",
        consequence:
          env.NODE_ENV === "production"
            ? "Serving in degraded mode; /health/ready reports 503 until the schema is reachable."
            : "Exiting so a local developer sees the failure immediately.",
      });
      if (env.NODE_ENV !== "production") process.exit(1);
    }
  } else {
    log.warn("database_migrations_skipped", {
      reason: "No database URL is configured; starting in degraded mode.",
    });
  }
}

const server = Bun.serve({
  port: env.PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  idleTimeout: 30,
});

log.info("api_started", {
  port: server.port,
  environment: env.NODE_ENV,
  institution: env.INSTITUTION_NAME,
});
if (env.NODE_ENV === "production" && !env.TRUST_PROXY_HEADERS)
  log.warn("proxy_headers_not_trusted", {
    detail:
      "Rate limiting will use socket addresses. Set TRUST_PROXY_HEADERS=true on a proxied host.",
  });
startJobs();
// A sleeping free host cannot run cron. Nudge the first pass as soon as the
// process is awake, then let ordinary traffic keep it on schedule.
maintenanceTick(true);

process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on("uncaughtException", (err) => {
  log.error("uncaught_exception", { error: err.message, stack: err.stack });
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("api_stopping", { signal });
    stopJobs();
    // Stop accepting, give in-flight requests a bounded window, then close the pool.
    const drain = Promise.resolve(server.stop());
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    try {
      await closeDb(getDb());
    } catch {
      // The pool may never have opened (for example, a config failure at boot).
    }
    process.exit(0);
  });
}
