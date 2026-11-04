import { closeDb, getDb } from "../db/client";
import { pruneOperationalTables, runMaintenance } from "./maintenance";

/** One-shot runner for cron: `bun run jobs:run`. */
async function main() {
  const result = await runMaintenance();
  const pruned = await pruneOperationalTables();
  console.log(JSON.stringify({ ...result, pruned }, null, 2));
  await closeDb(getDb());
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
