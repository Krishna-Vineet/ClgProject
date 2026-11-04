# Phase 6 critic audit

Scope: everything built in Phases 1–6 — API, website, mobile, shared package, deployment config, documentation. Method: read the code paths that changed, grep for the failure patterns that bit us before, validate external config against the vendors' own schemas, and re-run the suites. Only defects I could reproduce or prove from a primary source are listed as fixed; anything speculative is listed as a watch item.

---

## Confirmed defects, fixed

### A1 — `render.yaml` could not deploy (blocker)
`runtime: bun` is not a valid Render runtime. Render's published schema (`https://render.com/schema/render.yaml.json`) allows `docker, elixir, go, image, node, python, ruby, rust, static` — Bun is a *toolchain inside the Node image*, selected with `BUN_VERSION` or `.bun-version`. Four env values were also YAML booleans (`false`/`true`), which the schema rejects; env values must be strings.
**Fix:** `runtime: node` with `BUN_VERSION=1.4.4`, all boolean values quoted. Both `render.yaml` and `vercel.json` now validate with **0 errors** against the vendors' schemas, and the docs explain why the runtime is `node`.

### A2 — Dashboard trend used UTC days (data correctness)
`date_trunc('day', created_at)` ran in the DB session timezone (UTC) and the 14 keys were generated with `toISOString()`. For a campus on `Asia/Kolkata`, every confirmation between 00:00 and 05:30 IST landed on the previous day, and the last bucket could be labelled with yesterday's date.
**Fix:** truncate `AT TIME ZONE CAMPUS_TIMEZONE`, generate keys with `Intl.DateTimeFormat` in the same zone, and bound the window by campus days rather than a rolling 13×24 h. Grouping by the repeated expression sent a second bound parameter and Postgres rejected it (`42803`); grouping by output column 1 is correct and tested. The chart label now formats the `YYYY-MM-DD` parts directly instead of round-tripping through `Date`, so a viewer in any browser timezone sees the same campus day.
**Regression test:** "trend day keys follow the campus timezone, not UTC" — asserts the last key equals today in campus time, 14 unique keys, ascending.

### A3 — `admin:bootstrap` required secrets it does not use (deployment blocker)
It called `readEnv()`, the full API validator, so a one-time database bootstrap failed unless JWT, email and storage variables were also present — and it threw a raw stack trace.
**Fix:** reads only `DATABASE_URL` plus the three `BOOTSTRAP_ADMIN_*` values, validates them with Zod, and prints `Bootstrap refused: <reason>` with exit code 1. Verified on a fresh migrated database: creates the Principal, and a second run refuses because an Admin exists.

### A4 — Faculty lost the Events tab (UI regression from this round)
Narrowing `isCoordinator` to LEAD/COORDINATOR also removed read access for club FACULTY, and one render guard still read `isCoordinator`, leaving a blank panel.
**Fix:** separate `isClubMember` (read) from `isCoordinator` (write); Events/Clubs/Reports use the former, creation uses the latter. Faculty see a read-only title and a disabled **New draft**. Covered by a dashboard e2e assertion.

### A5 — "New event" quick action did nothing on a cold load
The signal was consumed before `/me/clubs` resolved, so the draft form never opened.
**Fix:** consume the signal only once clubs are loaded (`useRef(0)` + `clubs.length` guard). Covered by the dashboard e2e quick-action test. Optional prop typed as `number` internally so strict `exactOptionalPropertyTypes` cannot reintroduce `undefined`.

### A6 — `.env.example` drifted from the code
It advertised `QR_HMAC_SECRET` and `EXPO_ACCESS_TOKEN`, neither of which any source file reads, and omitted `REPORT_MAX_ATTENDEES` and a usable `EXPO_PUBLIC_API_URL` entry. A developer following the template would set dead keys and miss real ones.
**Fix:** removed the dead keys, added the missing ones, and added a parity check of every `env.ts` key against the template — now **0 missing**.

### A7 — Documentation contradicted the implementation
`security.md` claimed rate limits were in-process; they are actually stored in Postgres and shared across instances. `troubleshooting.md` contained a stray non-English fragment. Test counts were stale.
**Fix:** corrected the rate-limit description (and documented the real caveat: `X-Forwarded-For` is trusted only when `TRUST_PROXY_HEADERS=true`), fixed the text, updated counts to 260.

### A8 — Dashboard test depended on whatever ran before it
It logged in with `SEED_DEMO_PASSWORD`, but nine other suites rewrite those demo hashes to their own fixture passwords. Run alone after another suite, it failed with 401 — a false alarm that would have looked like a product bug.
**Fix:** the suite sets its own fixture password in `beforeAll`. It now passes in isolation, in the full run, and on a freshly seeded database.

---

## Checks that came back clean

| Question | How checked | Result |
|---|---|---|
| Any mock/placeholder data in the UI? | grep for `TODO/FIXME/mock/placeholder` across API, web, mobile, shared | only a comment in `seed.ts`; no fake UI data |
| Unbounded Zod arrays (GHSA-mrhx-c7xc-m3w5)? | grep every `z.array(` for a `.max()` | **0 unbounded** |
| Dynamic SQL identifiers (GHSA-gpj5-g38j-94v9)? | grep `sql.identifier` / `.as(` | **0 occurrences** — advisory not applicable |
| Secrets or absolute localhost URLs in browser code? | grep web/mobile sources | none; web uses relative URLs only |
| Tokens in `localStorage`? | grep storage use | only the theme preference; refresh token is an httpOnly cookie, mobile uses SecureStore |
| XSS via raw HTML? | grep `dangerouslySetInnerHTML`, `target="_blank"` | none |
| Does the documented command set exist? | parse every `bun run X` in docs against all four `package.json` files | all real scripts |
| Does CI work from scratch? | created `campusops_ci_sim`, ran migrate → seed → the full suite with the CI env | **260 pass, 0 fail**; database dropped afterwards |
| Is the lockfile consistent? | `bun install --frozen-lockfile` | no changes |
| Do the health/config endpoints the docs promise exist? | live `curl` | `/health/live` 200, `/health/ready` `database: ok`, `/api/v1/config` correct |
| Reproducible web build? | two consecutive builds, SHA-256 compare | identical |

---

## Watch items (not defects, deliberately not "fixed")

- **Free-tier cold starts.** Render free sleeps after 15 minutes; the first request takes ~1 minute. Documented, not hidden behind a fake loading state.
- **Free-tier egress.** Render may suspend a free service that generates unusually high outbound traffic — and our design talks to Neon, Brevo and S3. Fine for a pilot; move to a paid instance if it happens. Documented in deployment/security notes.
- **Dependency advisories.** `zod` array-validation advisory is mitigated by capped arrays rather than a major-version migration mid-phase; `glob`/`minimatch` are build-time only. Both are recorded with their reasoning.
- **Single-instance assumptions.** Rate limiting is DB-backed so it scales, but the maintenance timer is in-process; on free hosting it is disabled and a cron calls the endpoint instead.
- **Vercel rewrite placeholder.** `YOUR-API.onrender.com` must be replaced with the real host. It is called out in the deployment steps; a wrong value fails loudly (404s in Network), not silently.

---

## Explicitly still unverified

Real Brevo delivery, real S3 round-trip, an actual Render/Vercel deployment, and physical camera scanning of a printed poster. These need your credentials and hardware; the code paths fail fast with clear errors when the credentials are absent, and the deployment guide lists them as a post-deploy checklist.

## Verdict

No open blocker. The two findings that would have stopped a real deployment (A1, A3) and the one that would have produced wrong numbers on the dashboard (A2) are fixed and covered. Ready for your review.
