# Critique response: what changed, point by point

This is the record of the work done in response to the project review. Each entry
names the problem, what was wrong underneath it, and what now exists instead.
Committed as `1afd072` on branch `arena/90ef43a7-clgproject`.

Two items were closed by decision rather than by code:

- **Half-registered accounts can sign in.** Kept as designed. A `PENDING_EMAIL`
  account belongs to someone an administrator added, or a student who has not yet
  been verified; both need to sign in to finish their own setup. Nothing in the
  API lets a pending account read or change protected data.
- **Mobile is light-only.** The mobile app ships one palette, so declaring
  `userInterfaceStyle: "automatic"` would render native chrome dark against light
  cards. The single theme is now an explicit, documented decision
  (`apps/mobile/app.config.ts`), not an oversight.

## P0 — security and correctness

| # | Problem | Fix |
|---|---|---|
| 1 | Refresh-token reuse detection revoked **every** session a user had, so one stale tab signed the same person out on every device. | Sessions carry a `family_id` (login starts a chain, each rotation continues it). A replayed token revokes only its own family. Migration `0013`, test `account-paths.integration.test.ts`. |
| 2 | `sessions.ip_hash` was built from the left-most `X-Forwarded-For` entry — an address the caller chooses. | `auth/routes.ts#clientMeta` now uses `clientIp()`, the same trusted-hop resolution the rate limiter already used. |
| 3 | `/health/ready` reported success without touching the schema, and `render.yaml` probed `/health/live`, which passes while the database is gone. | Readiness checks `to_regclass('public.users')` and returns 503 when it cannot serve. Render probes `/health/ready`. Two tests, including a probe against an unreachable host. |
| 4 | Uploads were verified by comparing an object's header against the value the client supplied. A "PNG" could be HTML. | Magic-byte sniffing on completion (`sniffMimeType`); the presigned type and the stored type are no longer treated as independent evidence. |
| 5 | Consent was captured as a timestamp with no policy version, and had no export or deletion path. | `consentVersion` is stored beside `consentAcceptedAt`; acceptance is required at registration. `GET /me/export` and `POST /me/delete` exist, with UI on the account screen. |

## P1 — reliability and exposure

| # | Problem | Fix |
|---|---|---|
| 6 | Notification fan-out had `.limit(50)` and no `ORDER BY`, so escalations reached an arbitrary, unstable set of approvers. | Deterministic ordering (tenure, then id) and a log line when the cap truncates. |
| 7 | `AUTO_MIGRATE` defaulted on outside production and `process.exit(1)` on a cold-start failure — a crash loop on a free host. | Off in production; a failed migration in production now leaves a degraded instance answering 503. |
| 8 | No request timeout, so one stuck statement could occupy a pool slot forever and drain the pool. | `REQUEST_TIMEOUT_MS` (20 s) bounds the request and is sent to Postgres as `statement_timeout`; a stuck request returns 504 `REQUEST_TIMEOUT`. |
| 9 | Every authenticated request cost four queries after token verification. | Roles and memberships are fetched concurrently. |
| 10 | Idempotent replays returned the original `requestId` with no way to tell a replay from a new write. | The replay is marked with `Idempotent-Replay: true`, exposed through CORS. |
| 11 | `/auth/reset-password` and `/auth/verify-email` were unthrottled, making a 6-digit OTP guessable. | Both rate limited. |

## P2 — experience and craft

| # | Problem | Fix |
|---|---|---|
| 12 | Two search boxes on Events with the same placeholder; the local one searched titles only. | The workspace box says "Search this list by title…" and is labelled for screen readers; global search keeps its own placeholder. |
| 13 | The "Needs attention" tile rendered three bare numbers. | Each number sits above its own label, in one element, at a readable weight. |
| 14 | Every student got the organiser Scan orb, opening a screen that told them they had nothing to scan. | Only club members get the orb; students keep a plain Scan tab, because the same camera reads complaint posters. |
| 15 | `--muted` measured 4.43:1 on paper and 3.90:1 on the third surface — below AA. | `#676454`: 5.23:1 on paper, 5.04:1 and 4.60:1 on the darker surfaces. Applied to web and mobile tokens. |
| 16 | "MADE BY VINEET" while `INSTITUTION_NAME` was unused in the UI. | Both clients show the institution; the signed-in staff member sees their college. |
| 17 | Registration never sent `consentAccepted`, so consent was always null. | The mobile form requires a checkbox that names the policy version. |

## P3 — hygiene

| # | Problem | Fix |
|---|---|---|
| 18 | 43 screenshots and a stack of sample PDFs tracked in `e2e/` (5.7 MB). | Untracked and ignored; the suites regenerate them. |
| 19 | A stray `docs/autonomous-drone-lab-report.pdf`. | Moved to `docs/samples/sample-drone-lab-report.pdf`, where its purpose is stated. |
| 20 | Docs claimed 360 tests against 383 actual, and never mentioned the `btree_gist` failures. | README, `docs/testing.md`, `docs/environment.md`, `docs/deployment.md` and `.env.example` updated to the real numbers and the real configuration. |
| 21 | No client tests at all. | Web API client and mobile formatters tested; both suites are wired into `bun run check` and run in CI. |

## Gates at commit time

- `bun run lint` — clean (232 files).
- `bun run typecheck` — shared, API, web, mobile all exit 0.
- `bun run test` — 408 pass, 5 fail; the five are the pre-existing
  `EXCLUDE USING gist` tests that need `btree_gist`, which the sandbox Postgres
  does not have.
- `bun run test:clients` — 11 pass.
- `bun run build:web` — builds.
- Browser walkthrough (real Chromium, real API): sign-in, account screen, data
  export download, delete-until-confirmed behaviour, labelled dashboard tile, zero
  page errors.
