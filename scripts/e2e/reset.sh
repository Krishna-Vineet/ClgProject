#!/usr/bin/env bash
# Rebuild the demo dataset from an empty schema through the product API only.
# Requires: Postgres reachable at DATABASE_URL, and the API running on API_BASE.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export SCENARIO_DOCS="${SCENARIO_DOCS:-$ROOT/docs}"
export DATABASE_URL="${DATABASE_URL:-postgresql://campusops@127.0.0.1:55432/campusops_dev}"
export SCENARIO_BASE="${SCENARIO_BASE:-http://127.0.0.1:8787/api/v1}"

cd "$ROOT"
bun "$HERE/resetdb.mjs"
bun run db:migrate
BOOTSTRAP_ADMIN_EMAIL=admin@northfield.edu \
BOOTSTRAP_ADMIN_NAME="Dr. Meera Iyer" \
BOOTSTRAP_ADMIN_PASSWORD='CampusOps#2026' \
bun run admin:bootstrap

cd "$HERE"
for step in 1 2 3 4 5 6 7; do
  echo "── step $step ──"
  node "step$step.mjs" 2>&1 | tee "step$step.log"
done
echo "steps 1-7 complete"
