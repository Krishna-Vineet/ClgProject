# Phase 6 report — production management UI, developer guide, critic audit

**Status:** implemented, tested and audited. Awaiting your review before anything further is built.
**Date:** 2026-11-01 · **API/OpenAPI:** 0.6.0 · **Implementation phase marker:** 6

Three things were asked for, in this order: (1) redesign the management website to a production standard using your six reference screenshots, (2) write a complete basic developer guide, (3) run a critic audit over everything built so far and fix what it finds. All three are done. Nothing was faked to make a screen look finished — every number, list and control on the new website comes from the live API.

---

## 1. The website redesign

### What changed visually

The old console was a row of text tabs above plain forms. The new one follows the layout language of your references: a fixed left sidebar with grouped navigation, a top bar with global search and utilities, a light card-based canvas, and a dashboard that answers "what needs me today?" before anything else.

| Area | Before | Now |
|---|---|---|
| Navigation | flat tab strip, wrapped on small screens | 250 px sidebar grouped **Workspace / Institution / You**, active pill, off-canvas drawer below 900 px with overlay + Escape + close-on-navigate |
| Top bar | none | breadcrumbs, global event search (`Ctrl/⌘ K`, debounced, live API results), theme toggle, notifications popover fed by the real work queue, avatar menu |
| Landing screen | event list | role-scoped dashboard: 4 KPI cards, 14-day confirmation trend, work queue, upcoming/live events, event pipeline, next approvals |
| Cards & tables | bare borders | 18 px radius, soft shadows, consistent spacing scale, horizontally scrollable tables (`.scroll-x`) so nothing overflows on a phone |
| Colour | one flat theme | design tokens in `styles/global.css`, light **and** dark (`data-theme`), violet `#5b55eb` accent, semantic status colours |
| States | blank while loading | skeletons, empty states with a next action, inline error notes, per-screen error boundary with "Try again" |
| Accessibility | partial | skip link, labelled icon buttons, `aria-current` on nav, focus-visible rings, `role="alert"` on errors, chart has a text summary |

Screenshots (real Chromium, real seeded data): `e2e/p6-00-login.png`, `p6-01-dashboard.png`, `p6-02-dark.png`, `p6-03-events.png`, `p6-04-390.png`, `p6-04-768.png`.

### New backend the dashboard needed

`GET /api/v1/me/dashboard` — one role-scoped call instead of six fan-out requests:

```
{ generatedAt, scope: INSTITUTION | DEPARTMENT | CLUBS | PERSONAL,
  events { total, live, upcoming, draft, pendingApprovals, completed },
  registrations { confirmed, waitlisted, applied },
  work { approvalsPending, verificationPending, openComplaints, resourceHolds },
  upcoming[≤6], confirmationTrend[14], approvalQueue[≤4] }
```

Scope is resolved from the caller's real roles and memberships: Admin sees the institution, HOD/Dean their departments, coordinators their clubs, everyone else only their own workload. A student calling it gets zeros, not other people's data. Complaint counts are organiser-only. Day buckets follow `CAMPUS_TIMEZONE`, not the database's UTC clock.

### Roles in the UI (and a regression this surfaced)

Club **faculty** are read-only: they can see events, clubs and reports, and scan at a venue, but cannot create or edit. The redesign initially hid the Events tab from them entirely; that is fixed by separating two flags — `isClubMember` (any active membership → read access) and `isCoordinator` (LEAD/COORDINATOR → create/manage). Faculty now see "Club events (read-only)" with **New draft** disabled. The API enforced this correctly all along; only the UI was wrong.

### What did not change

No student web portal. No mobile approvals. No new roles. Every existing flow — approvals with individual decisions and escalation, resources, clubs, verification, QR rules, complaint posters, PDF reports, administration — is still wired to the same endpoints.

---

## 2. The developer guide

Nine documents under `docs/`, indexed by [`docs/README.md`](README.md):

| Guide | Covers |
|---|---|
| [getting-started.md](getting-started.md) | tool versions, database creation (local or Neon), `.env.local`, migrate/seed, run all three apps, demo logins, verify |
| [monorepo.md](monorepo.md) | what a monorepo is, why this one is, workspaces, `workspace:*`, one lockfile, one TS baseline, how shared code reaches all apps, how to add a package |
| [environment.md](environment.md) | every variable grouped by purpose; which file it lives in; what is secret; why `VITE_*`/`EXPO_PUBLIC_*` are public; secret rotation |
| [architecture.md](architecture.md) | request flow, auth/session model, roles and scope, event lifecycle, QR decision order, storage, outbox, jobs, frontend structure |
| [testing.md](testing.md) | the five test layers, exact commands, how to filter, how to add a test, what CI runs, what is manual |
| [deployment.md](deployment.md) | Neon → Render → Vercel → mobile, in order, with the first-Admin bootstrap, Brevo, S3, maintenance cron and a post-deploy checklist |
| [troubleshooting.md](troubleshooting.md) | symptom → cause → fix tables for setup, DB, auth, web/mobile, deployment, sandbox |
| [security.md](security.md) | what is enforced server-side, client responsibilities, accepted risks |
| [mobile.md](mobile.md) | (existing) Expo setup, pinned versions, device testing |

### Deployment wiring, in one paragraph

The website calls **relative** `/api/v1/...` URLs. `vercel.json` rewrites `/api/*` and `/health/*` to your Render API, so the browser sees a single origin and the httpOnly refresh cookie is first-party — this is what makes "stay signed in after reload" work despite third-party-cookie blocking. The website therefore needs **no** environment variables. All secrets (Neon URLs, JWT secret, refresh pepper, QR key, Brevo key, S3 keys) live only on the Render API service. The native mobile build needs one public value, `EXPO_PUBLIC_API_URL`, pointing at the same API.

### New production scaffolding

- `render.yaml` — API service, free plan, health check, production-safe defaults, secrets marked `sync:false`. Validated against Render's published JSON schema.
- `vercel.json` — Vite build, API rewrites, SPA fallback, immutable asset caching, security headers. Validated against Vercel's schema.
- `.github/workflows/ci.yml` — Postgres 17 → frozen install → lint → typecheck → migrate → seed → test → build.
- `bun run admin:bootstrap` — creates the **first** Principal/Admin on an empty production database from `BOOTSTRAP_ADMIN_*`, refuses if any Admin already exists or the email is taken, needs only `DATABASE_URL`. There is still no public staff signup and no demo account in production.
- `bun run check` — lint + typecheck in one command.

---

## 3. Verification

Full log: [`phase6-verification.log`](phase6-verification.log).

| Gate | Result |
|---|---|
| Lint (Biome, all workspaces) | **177 files, clean** |
| Typecheck (shared / API / web / mobile) | **4/4 exit 0** |
| API unit + integration | **260 pass, 0 fail** (20 files) |
| Same suite on a brand-new database (CI simulation) | **260 pass, 0 fail** |
| Web production build | succeeds; **byte-identical** across two runs |
| Browser e2e — dashboard | **9 pass, 0 fail** |
| Browser e2e — access QRs + complaints | **25 pass, 0 fail** |
| Browser e2e — event portal/lifecycle | **32 pass, 0 fail** |
| Browser e2e — management/admin | **39 pass, 0 fail** |
| Browser e2e — mobile preview | **12 pass, 0 fail** |
| Console/page errors across all suites | **0** |
| OpenAPI | 0.6.0, **101 paths / 118 operations**, parity test green |
| `render.yaml` / `vercel.json` | **0 schema errors** each |
| Admin bootstrap | succeeds on empty DB; refuses second Admin; refuses weak password |

Responsive checks run at 390 px and 768 px: zero horizontal overflow, drawer opens/closes correctly.

---

## 4. What the audit found and fixed

Detailed in [`phase6-audit.md`](phase6-audit.md). Eight real defects were confirmed and fixed, the most consequential being:

1. **`render.yaml` would have failed to deploy** — `runtime: bun` is not a valid Render runtime, and unquoted booleans are rejected. Now `runtime: node` + `BUN_VERSION=1.4.4` with quoted values; validated against the official schema.
2. **Dashboard trend was bucketed in UTC** — an 00:30 IST confirmation appeared on the previous day. Now grouped in the campus timezone, with a regression test.
3. **`admin:bootstrap` demanded unrelated secrets** — it called the full API env validator, so it failed without JWT/email/S3 configured. It now needs only `DATABASE_URL`.
4. **`.env.example` advertised two variables the code never reads** (`QR_HMAC_SECRET`, `EXPO_ACCESS_TOKEN`) and omitted two it does. Corrected and parity-checked against `env.ts`.

---

## 5. Not done / not claimed

- No real deployment: you supply Neon/Brevo/S3 values and run the deploy. The config is validated, not yet exercised against live accounts.
- Real Brevo delivery, real S3 upload/download and physical camera/poster scanning remain manual tests on your side.
- Quizzes and both seat-allocation modes stay in Evaluation 2; registration cancellation and offline scan queue remain deferred. The API refuses quiz modes rather than pretending.
- Dependency advisories with no applicable code path are documented, not silently ignored (see the audit).

**Next step is yours:** review the new UI in the live preview, read the guide, and tell me what to change. I will not start another phase until you approve this one.
