#!/usr/bin/env bash
# Restore the local review environment after a sandbox reset.
#
# WHY THIS EXISTS
# The workspace snapshot only persists files under /home/user, and it excludes
# node_modules, caches and build output. Installed tooling (Bun, PostgreSQL) and
# the local database cluster therefore do NOT survive a reset. Source files,
# migrations, seed data and docs DO survive, so everything is reproducible.
#
# IMPORTANT: keep the Bun binary and its cache OUTSIDE /home/user, or the ~103 MB
# binary counts against the snapshot cap and new files stop being saved.
#
# Usage: bash scripts/restore-sandbox.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

echo "── 1/5 Bun ───────────────────────────────────────────────"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/tmp/bun-install bash
  install -m 0755 /tmp/bun-install/bin/bun /usr/local/bin/bun
  rm -rf /tmp/bun-install
fi
# Never let the package cache land inside the snapshot path.
export BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
mkdir -p "$BUN_INSTALL_CACHE_DIR"
echo "bun $(bun --version) at $(command -v bun)"

echo "── 2/5 Dependencies ──────────────────────────────────────"
bun install

echo "── 3/5 PostgreSQL ────────────────────────────────────────"
if [ ! -x /usr/lib/postgresql/17/bin/postgres ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql-17 postgresql-client-17
fi
if ! pg_isready -h 127.0.0.1 -p 55432 >/dev/null 2>&1; then
  echo "Start PostgreSQL with the process tool (it must outlive this script):"
  echo "  sudo -u postgres /usr/lib/postgresql/17/bin/postgres \\"
  echo "    -D /var/lib/postgresql/17/main \\"
  echo "    -c config_file=/etc/postgresql/17/main/postgresql.conf \\"
  echo "    -p 55432 -c listen_addresses=127.0.0.1"
  exit 2
fi

echo "── 4/5 Databases ─────────────────────────────────────────"
sudo -u postgres psql -p 55432 -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='campusops'" | grep -q 1 || \
  sudo -u postgres psql -p 55432 -c \
    "CREATE ROLE campusops WITH LOGIN PASSWORD 'campusops' CREATEDB;"
for DB in campusops_dev campusops_test; do
  sudo -u postgres psql -p 55432 -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 || \
    sudo -u postgres psql -p 55432 -c "CREATE DATABASE $DB OWNER campusops;"
  DATABASE_URL="postgresql://campusops:campusops@127.0.0.1:55432/$DB" bun run db:migrate
done

echo "── 5/5 Seed + verify ─────────────────────────────────────"
if [ -f "$ROOT/.env.local" ]; then
  set -a; . "$ROOT/.env.local"; set +a
else
  echo "NOTE: .env.local missing. Copy .env.example and generate secrets:"
  echo "  openssl rand -hex 32   # JWT_ACCESS_SECRET and REFRESH_TOKEN_PEPPER"
fi
bun run db:seed
# The test database needs the same seed: constraint and integration tests assert
# against seeded rows, so seeding only dev leaves them failing after a reset.
DATABASE_URL="postgresql://campusops:campusops@127.0.0.1:55432/campusops_test" bun run db:seed
TEST_DATABASE_URL="postgresql://campusops:campusops@127.0.0.1:55432/campusops_test" bun run test

echo
echo "Restored. Workspace footprint (should be a few MB, not 100+):"
du -sh /home/user --exclude=node_modules 2>/dev/null || du -sh /home/user

# ---------------------------------------------------------------------------
# Browser walkthrough (optional). Playwright's own CDN is often unreachable in
# the sandbox, so use the distro Chromium instead:
#
#   sudo apt-get update && sudo apt-get install -y chromium
#   set -a; . ./.env.local; set +a
#   E2E_CHROMIUM_PATH=/usr/bin/chromium E2E_PASSWORD="$SEED_DEMO_PASSWORD" \
#     bun run e2e/portal.mjs
#
# The API (:8787) and web (:5173) servers must already be running.
# ---------------------------------------------------------------------------
