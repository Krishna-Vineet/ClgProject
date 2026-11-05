# Testing

## Layers

| Layer | Command | What it proves | Needs |
|---|---|---|---|
| Lint/format | `bun run lint` | Biome rules across all workspaces | nothing |
| Types | `bun run typecheck` | Strict TS in shared, API, web, mobile | nothing |
| API unit + integration | `bun run test` | 421 tests: domain rules, auth/session/refresh-reuse-by-family, consent versioning, account export/delete, roles/scope, staff-directory scoping, approvals/escalation, resource exclusion, registrations race/waitlist, QR rules/scan/replay, complaints privacy, reports immutability, OpenAPI parity, dashboard scoping | `TEST_DATABASE_URL` (migrated + seeded) |
| Web build | `bun run build:web` | Production bundle compiles; deterministic output | nothing |
| Browser e2e (web) | `bun run e2e:all` | Dashboard, events lifecycle, approvals, admin, clubs, resources, verification, QR rules, complaint posters, reports — real Chromium against real API | API :8787 + web :5173 + `E2E_PASSWORD` |
| Browser e2e (mobile) | `bun run e2e:mobile` | Exported mobile bundle: auth, events, passes, scanner, complaints, profile, signup fields, 390 px overflow | API + mobile preview :8081 + `E2E_PASSWORD` |
| Mobile compatibility | `cd apps/mobile && npx expo install --check && npx expo-doctor` | Expo SDK / native module version alignment | Node ≥22.13 |
| Native bundles | `npx expo export --platform android` / `ios` | Metro + Hermes compile the native app | Node ≥22.13 |

## Running the API suite

```bash
# Test DB must exist, be migrated and seeded (the suite asserts against seeded rows)
bun run db:migrate
DATABASE_URL="$TEST_DATABASE_URL" bun run db:seed
bun run test
```

Five tests exercise real `EXCLUDE USING gist` constraints and skip-fail on a Postgres without `btree_gist`. They are the only reason a local run reports fewer passes than CI, which installs the extension.

`apps/api/bunfig.toml` preloads `tests/setup.ts`, which forces `NODE_ENV=test`, points `DATABASE_URL` at `TEST_DATABASE_URL`, and enables demo email. Tests create their own rows with unique stamps; they never touch the dev database. **Never point `TEST_DATABASE_URL` at production.**

Filter while developing:

```bash
cd apps/api
bun test tests/access-rules.test.ts
bun test tests/dashboard.integration.test.ts -t "admin"
```

## Browser walkthroughs

```bash
set -a; . ./.env.local; set +a
export E2E_PASSWORD="$SEED_DEMO_PASSWORD"
export E2E_CHROMIUM_PATH=/usr/bin/chromium   # if Playwright's download is blocked
bun run e2e:dashboard    # shell, dashboard, theme, search, responsive
bun run e2e:access       # QR rules + complaint posters + club faculty
bun run e2e              # event lifecycle + reports
bun run e2e:management   # admin, clubs, resources, verification, account
bun run e2e:mobile       # mobile preview
```

Each suite prints `PASS/FAIL` lines, writes screenshots into `e2e/`, and exits non-zero on any failure or unexpected console/page error. Expected negative responses (403/404/409 in adversarial steps) are declared in the scripts so they are not counted as errors.

For local suites that log in many times from one IP, start the API with `RATE_LIMIT_SCALE=10`; **never** set that in production.

## CI

`.github/workflows/ci.yml` spins up Postgres 17, installs with the frozen lockfile, then runs lint → typecheck → migrate → seed → test → build. Browser suites are run locally/manually because they need seeded demo logins and a browser binary.

## Adding a test

- Pure rule? Add to `apps/api/tests/*.test.ts` (no DB) — e.g. `access-rules.test.ts`.
- HTTP behaviour? Add an integration test that calls `createApp().request(...)`; create fixtures with unique ids/emails; assert status codes and error codes, not just happy paths.
- New route? Add it to `openapi/manifest.ts`; the parity test will fail otherwise.
- UI flow? Extend the matching `e2e/*.mjs`; use `data-testid`/labels, wait for real data, and declare expected HTTP errors.

## What is not tested automatically

Physical camera scanning and printed posters (device test), real Brevo delivery and real S3 (your credentials), Render/Vercel deployment, quizzes (Evaluation 2). These are listed as manual steps in [deployment.md](deployment.md).
