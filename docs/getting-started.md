# Getting started (local development)

## 1. Install the tools

| Tool | Version | Why |
|---|---|---|
| **Bun** | 1.4.4 (pinned in `.bun-version`) | Runs the API, installs packages, runs tests and scripts |
| **Node.js** | ≥ 22.13 (pinned `apps/mobile/.node-version` = 22.23.4) | Expo CLI / Metro for the mobile app only |
| **PostgreSQL** | 17 locally, or a free **Neon** project | The only database |
| Git | any recent | Version control |

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash          # installs Bun
# Node: use nvm/fnm/volta, e.g.
nvm install 22.23.4 && nvm use 22.23.4
```

Windows: install Bun via `powershell -c "irm bun.sh/install.ps1|iex"` and Node from nodejs.org, or use WSL2 (recommended; all commands below then work unchanged).

> Keep the Bun binary **outside** the project folder. Never commit `node_modules`, actual `.env.*` files, `dist`, or `.expo`. The committed `.env.*.example` files are safe templates.

## 2. Get the code and install once

```bash
git clone <your-repo-url> campusops && cd campusops
bun install
```

`bun install` reads the single root `bun.lock` and installs dependencies for **every** workspace (`apps/api`, `apps/web`, `apps/mobile`, `packages/shared`). You do not run `npm install` inside each app. See [monorepo.md](monorepo.md).

## 3. Create a database

**Option A — Neon (no local Postgres needed).** Create a project at neon.tech, copy the *pooled* and *direct* connection strings.

**Option B — local Postgres 17.**

```bash
sudo -u postgres psql -c "CREATE ROLE campusops LOGIN PASSWORD 'campusops' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE campusops_dev OWNER campusops;"
sudo -u postgres psql -c "CREATE DATABASE campusops_test OWNER campusops;"
```

## 4. Create the local env file

From the repository root (PowerShell):

```powershell
Copy-Item .env.example .env.local
```

Fill `.env.local` with the database URLs and two different random secrets (`JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`). For local demo email, set `DEMO_MODE=true`; the template includes the remaining local defaults.

`PORT` is the API port (8787 by default). The Vite proxy follows `API_PORT`, then `PORT`, and automatically checks 8787 and 8087 at startup, so a single file is enough. For a phone, set `EXPO_PUBLIC_API_URL` to your PC's LAN IPv4, for example `http://192.168.1.41:8787` — not localhost. The API host must be allowed through Windows Firewall.

Bun loads `.env.local` automatically for every root command, and child processes inherit it. More details: [environment.md](environment.md).

## 5. Migrate

```powershell
bun run db:migrate
bun run db:check
```

The migration runner applies all numbered migrations in order. Demo seed data is optional and is not run by app startup.

## 6. Run the apps

Open terminals at the repository root:

```powershell
bun run dev:api       # API on the PORT from .env.local; normal mode, no --hot
bun run dev:web       # Management website on :5173; proxy follows API_PORT/PORT
bun run dev:mobile    # Expo Go/LAN; API origin from EXPO_PUBLIC_API_URL
```

The API runs without Bun hot reload, so Ctrl+C stops the process normally. Use Node.js 22.13+ for Expo/Metro.

Scan the QR with Expo Go (same Wi‑Fi). `localhost` on a phone means the phone itself, so use your computer's LAN IP. See [mobile.md](mobile.md).

## 7. Sign in

Demo accounts (password = your `SEED_DEMO_PASSWORD`):

| Role | Email |
|---|---|
| Admin (Principal) | `principal@demo.campusops.local` |
| HOD/Dean | `hoddean.cse@demo.campusops.local` |
| Faculty | `faculty.cse@demo.campusops.local` |
| Club lead (coordinator) | `coding.lead@demo.campusops.local` |
| Verified college student (mobile) | `student.verified@demo.campusops.local` |
| Outside student (mobile) | `outsider@demo.campusops.local` |

The website is **management-only**. Students sign in on the mobile app; a student without a staff role or club membership is told to use the app.

## 8. Verify everything

```bash
bun run check          # lint + typecheck (all workspaces)
bun run test           # 260 API tests against TEST_DATABASE_URL
bun run build:web      # production website build
E2E_PASSWORD="$SEED_DEMO_PASSWORD" bun run e2e:all       # real-browser walkthroughs (API + web running)
E2E_PASSWORD="$SEED_DEMO_PASSWORD" bun run e2e:mobile    # mobile preview running on :8081
```

Details and how to add tests: [testing.md](testing.md).
