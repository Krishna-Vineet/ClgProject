# CampusOps — independent product & engineering review

**Reviewer stance:** judge the product that exists, not the one the docs promise.
**Method:** source review of the API, web console and mobile app; the last full gate run
(360 API tests, lint/typecheck clean); database schema and constraints; deployment and CI
configuration; and the recorded DOM walk of the web and mobile bundles. The final warm
"Ledger" redesign could not be screenshotted in this environment (no Chromium), so visual
judgement is based on the CSS/design system, component code and rendered DOM text. The
screenshots in `e2e/` are from the **previous purple design** and are stale evidence.

---

## Verdict

This is not a generic campus event app. It is a **back-office for the people who run events** —
permission-by-permission approvals, conflict-free resource bookings, rotating QR access, and an
immutable post-event record. That focus is the product's real moat and it is executed with
uncommon depth for a project of this size.

It is **pilot-ready for one college after two to three weeks of hardening**, and **not yet
production-ready as a multi-college product**. The gaps are not in the domain model; they are in
adoption (SSO, setup, communications), operations (observability, cron, error mapping) and the
student phone experience.

### Scorecard

| Dimension | Grade | One-line judgement |
|---|---|---|
| Domain model & backend correctness | **A−** | Deep, transaction-safe, constraint-backed; a few 500-shaped edges remain |
| API design & contracts | **A** | Zod + OpenAPI parity, consistent envelope, idempotency on writes |
| Security & privacy | **B+** | Strong auth/token/QR/storage hygiene; no SSO, consent or retention story |
| Reliability & operations | **C+** | No tracing/metrics, cron documented in a way that cannot work, sync PDF |
| Web UI craft | **A−** | Distinctive, coherent, accessible; a genuinely original design language |
| Web UX & feature completeness | **B+** | Excellent operator flows; weak discovery, exports and deep links |
| Mobile UI craft | **B** | Warm, legible, well-written; six tabs and no dark mode/dynamic type |
| Mobile UX & feature completeness | **B−** | Scanner/offline/quiz are strong; day-of and notification polish is missing |
| Testing & CI | **B−** | 360 API tests is excellent; zero client tests and no mobile job in CI |
| Docs & developer experience | **B** | Unusually thorough, but stale status, stale screenshots, placeholder deploy host |

**Overall:** ~**8.0/10 engineering**, ~**7.0/10 production readiness**.

---

## 1. Backend

### What is genuinely strong

- **Domain depth.** 47 tables, 19 modules, ~18k lines. Approvals are modelled per permission with
  tiered escalation; resources use a PostgreSQL exclusion constraint so double-booking is
  impossible; registrations use row locks plus waitlist promotion in the same transaction; access
  decisions are a shared pure function used by both API and tests.
- **Correctness discipline.** 70 transactions, row locking (`FOR UPDATE SKIP LOCKED`), append-only
  audit enforced by a trigger, rotating HMAC QR tokens with hashed single-use nonces, and
  idempotency keys on the writes that matter.
- **Contracts.** OpenAPI 3.1 is generated from the validating Zod schemas, and a parity test fails
  if a mounted route is undocumented. Response envelopes are consistent (`{data, requestId}` /
  `{error:{code,message,details}, requestId}`).
- **Security fundamentals.** Argon2id passwords, short-lived HS256 access tokens, opaque rotating
  refresh tokens with family revocation, httpOnly cookie on web, SecureStore on native, scoped
  RBAC resolved from the database, private S3 with signed URLs and server-side HEAD validation,
  and no secrets in Git.
- **Test depth.** 27 files / 360 tests covering roles, constraints, concurrency, offline sync,
  contracts and the OpenAPI surface.

### What I would fix

**P0 — constraint violations still become 500s.** `middleware/error-handler.ts` maps only
`22P02/22007/22008`. `utils/db-error.ts` already has `isUniqueViolation`, `isCheckViolation`,
`isForeignKeyViolation` and `isExclusionViolation`, but almost nothing uses them. A duplicate,
a check violation or a racing exclusion surfaces as `INTERNAL_ERROR`. Map them centrally:
`23505 → 409 RESOURCE_CONFLICT`, `23514 → 422 VALIDATION_ERROR`, `23503 → 409`,
`23P01 → 409 RESOURCE_CONFLICT`, `40001/40P01 → 409 retryable`. This is the single cheapest
improvement to the "no 500s" promise.

**P0 — the documented production cron cannot authenticate.** Access tokens live 15 minutes and the
deployment guide tells operators to call `POST /admin/jobs/maintenance` every 2 minutes with
`Bearer <an admin access token>`. That token will always be expired. Add a dedicated
`X-CampusOps-Job-Token` (HMAC of timestamp + body, 5-minute window) or a signed cron URL, and
document rotation. Otherwise holds, lifecycle transitions and the outbox silently stop in the
exact deployment shape you recommend.

**P1 — rate limiting loses its identity when proxy trust is off.** `clientIp()` returns the literal
`"direct"` unless `TRUST_PROXY_HEADERS=true`, which collapses every anonymous login and
registration into one global bucket. The production blueprint sets it true, but a forgotten env var
turns 20 logins/minute into a campus-wide lockout. Fail closed in production (refuse to boot, or
require an explicit `TRUSTED_PROXY_HOPS`), and take the client IP from the socket when untrusted.
Also note that a spoofable `X-Forwarded-For` first entry is used when trust is on; use the
right-most untrusted hop.

**P1 — idempotency has a check-then-act race.** `middleware/idempotency.ts` reads for a key, then
runs the handler, then inserts the response. Two simultaneous requests with the same key both miss
and both execute. Insert an `IN_PROGRESS` row under a unique constraint before calling `next()`;
have the loser return `409 IDEMPOTENCY_IN_PROGRESS` or retry-after.

**P1 — reports are generated synchronously in the request.** A PDF with up to 2,000 attendees is
built and stored during `POST /events/:id/reports`. On a sleeping free instance this is a timeout
waiting to happen. Enqueue it (`pg-boss`/BullMQ), return `202` with a report status, and let the UI
poll — the same worker can do CSV/XLSX exports.

**P1 — outbound email has no timeout.** Expo push correctly uses `AbortSignal.timeout(10_000)`;
Brevo/Resend calls in `utils/email.ts` do not. One hung provider connection holds an outbox worker
and its transaction open.

**P2 — job locking holds an advisory lock across network sends.** `withJobLock` wraps the whole job
in a transaction; the outbox dispatcher then performs HTTP calls inside it. It is safe today, but it
keeps a database connection and the lock for the duration of the slowest email. Use a session-level
lock or structure the outbox as claim → commit → send.

**P2 — pagination is offset-based everywhere.** Fine for events, increasingly wrong for
`audit_logs`, `scan_logs` and registrations at scale. Add keyset pagination for append-only logs.

**P2 — lifecycle and operational edges.**
`index.ts` calls `server.stop()` and immediately `process.exit(0)` without draining in-flight
requests or closing the pool; add a bounded drain. `health/live` always reports OK while Render
health-checks that path — use `/health/ready` for deploy gating. There is no central
`unhandledRejection` logging and no request timeout.

**P2 — schema hygiene.** `chat_messages` exists with an index and zero readers/writers. Either build
the conversation feature or drop the table. Add `event_series`/recurrence if series events are on the
roadmap; today every event is a one-off.

**P2 — phone is collected but not operational.** `users.phone` is a nullable `text` capped at 30
characters, accepted only at registration, never normalised, never unique, never editable, never
verified, and never used to contact anyone. For the field you explicitly asked to add, that is a
half-feature. Make it E.164, verified by OTP, editable from the profile, and use it for reminders,
gate contact and emergency notices.

**P2 — no institution-wide audit or support tooling.** Event audit is good, but an admin cannot see
"who changed what across the institution", cannot search users, and cannot impersonate-with-audit
for support. Add a global audit view and a controlled support mode.

---

## 2. Services and infrastructure

| Service | Judgement |
|---|---|
| **PostgreSQL + Drizzle** | Excellent fit. The exclusion constraint and transactional domain logic justify the whole stack. Keep. |
| **Bun + Hono** | Excellent developer velocity; small surface, fast tests. Note the lock-in: `Bun.password` Argon2 and `Bun.serve` tie you to Bun. Acceptable if the deployment target is a Bun container. |
| **S3-compatible storage** | Well done: private bucket, purpose allow-list, signed PUT, HEAD verification, size/type checks, audit rows. |
| **Email (Brevo/Resend)** | Functional but plain-text only, no HTML templates, no timeout, no calendar invites, free-tier limits. This is the weakest service choice for a campus audience. |
| **Expo push** | Correctly treats the token as non-identity and reassigns across accounts. Missing tap-routing, badge clearing and fallback channel. |
| **Render + Vercel** | Adequate for a pilot, but free-tier sleep plus the cron-auth flaw makes the documented topology unreliable. Move the API to an always-on small container (Fly/Railway/Render paid) before a real event day. |
| **Missing: Redis** | Database-backed rate limits and idempotency add a write to hot paths. Fine at campus scale, not at 10×. Move to Upstash/Redis when you exceed one college. |
| **Missing: queue** | The transactional outbox is the right pattern; give it a real worker (`pg-boss` reuses Postgres and avoids a new service). |
| **Missing: observability** | No Sentry/OpenTelemetry, no metrics, no structured JSON logs, no alerting. You cannot operate an event-day system on `console.error`. |
| **Missing: SMS/WhatsApp** | Email is not how Indian students receive time-sensitive notices. WhatsApp Business or SMS fallback, driven by the verified phone, is the highest-impact service addition. |

---

## 3. Website (management console)

### UI — strong

The "Ledger" language is a real design position: warm paper, ink type, serif display, hairline rules,
one seal-red accent, dark mode, print styles. It does not look like a template. The details are
considered: 41 skeleton states, 39 empty states, a native `<dialog>` confirm with a focus trap,
skip links on both auth and console, `:focus-visible` rings, reduced-motion support, an error
boundary per panel, an offline banner, lazy panels with hover prefetch, and a sensible
information architecture (Workspace / Institution / You).

### UI — what I would change

1. **Split the 3,333-line `global.css` monolith** into tokens, primitives and feature layers, or move
   to CSS modules. It works, but it is now the hardest file in the repo to change safely.
2. **Create one source of design tokens.** Web CSS and `apps/mobile/components/ui.tsx` duplicate the
   same hex values. They will drift. Generate CSS variables and TS tokens from one file.
3. **Add a real web security header set.** `vercel.json` sets nosniff, referrer policy and
   frame-deny, but no CSP, HSTS or Permissions-Policy. Self-host Fraunces/Inter instead of loading
   Google Fonts, then ship a strict CSP.
4. **Contrast:** `--muted` is 4.43:1 on paper — just below AA for normal text. Darken it slightly.
5. **Search accessibility:** the results list has keyboard index state but no `role="listbox"`,
   `role="option"` or `aria-activedescendant`. Complete the combobox pattern.
6. **Replace stale screenshots** in `e2e/` — they show the pre-redesign purple UI and are actively
   misleading as evidence.

### UX — strong

The operator flows are coherent and unusually complete: approvals with per-permission trails,
resource calendars with conflict prevention, club/HOD structure, verification queue, a nine-tab
event workspace, QR management, complaints, announcements, quiz authoring and immutable reports.
Copy is direct and explains consequences ("a withdrawn participant cannot still scan in").

### UX — what I would change

1. **Kill hash routing; use real URLs.** `#/events` means no deep link to an event, report or
   approval, no shareable link to a colleague, and no meaningful browser history. Add
   `/events/:id`, `/approvals/:id`, `/reports/:id` and preserve the existing focus behavior.
2. **Make ⌘K a command palette, or rename it.** It says "Search events…" and searches only events.
   Operators will expect people, clubs, resources and actions. Add a global search endpoint and
   group results by type.
3. **Format every date in the campus timezone.** The mobile app pins `Asia/Kolkata`; the web uses
   the browser locale (`toLocaleDateString(undefined, …)`). A coordinator travelling or on a VPN
   sees shifted times. One `formatCampusDate` helper, used everywhere.
4. **Add the missing operator outputs:** attendee CSV/XLSX export (the `ATTENDEE_EXPORT` purpose
   already exists), `.ics`/Google Calendar links, and a public report-verification page keyed to the
   existing sha256 checksum.
5. **Build a first-run setup wizard.** Institution → departments → programmes → HODs → faculty →
   clubs is currently a manual tour through five panels. A guided checklist with progress would
   dramatically reduce time-to-value and is exactly the path you had to walk manually.
6. **Global audit + support view.** Admins need institution-wide history, user search and
   impersonation-with-audit; today audit is event-scoped only.
7. **Bulk operations:** verify multiple students, invite a CSV of outsiders, export a roster,
   duplicate an event as a template.
8. **A notification center**, not just a dropdown; approvals and complaints deserve a persistent
   inbox with filters.
9. **Onboarding help.** Contextual "how approvals work" / "what a hold is" help would prevent the
   most common operator confusion.

---

## 4. Mobile app

### UI — strong

The same warm language is carried into native: custom icons, a centred scan orb, serif titles,
hairline cards, badges, clear refusal copy for every QR failure reason, 22 accessibility labels,
30 accessibility roles and 47 test IDs. The scanner's offline queue messaging is excellent
("saved on this phone and not on the server yet"). The quiz timer uses the server clock and
auto-submits, which is the right call.

### UI/UX — what I would change

1. **Six tabs is one too many.** Platform guidance is five (iOS) and the Scan tab is only useful to
   organizers, yet every student sees it. Make Scan contextual (inside Events / an organizer mode),
   or replace Help with a combined "Issues" destination.
2. **No error boundary.** The original `title` crash white-screened the app; a single unexpected
   payload can still do it. Add a shell-level boundary plus per-screen boundaries with a "reload this
   screen" action — the web already has this discipline.
3. **Validate API responses at runtime.** The mobile types are hand-written. Parse with the shared
   Zod schemas (or generated types) at the `lib/api.ts` boundary so a shape change becomes a clear
   error, not `undefined`.
4. **No pull-to-refresh** anywhere, and lists are rendered inside `ScrollView` rather than
   `FlatList`. Add `RefreshControl` and virtualise event/roster lists.
5. **No connectivity awareness.** `expo-network` is installed and unused; the offline scan queue only
   flushes when the scanner screen is mounted. Add a network banner and flush on reconnect.
6. **Pass display is not day-of-ready.** No screen-brightness boost, no "tap to enlarge", no haptics
   or sound on scan, no continuous scan mode, no recent-scan count at the gate. These are the details
   that decide whether a queue moves.
7. **Passes cannot be shown offline.** Every code is minted server-side, so a dead zone at the gate
   stops entry. Consider a short-lived pre-issued code batch or a fallback static pass with
   server-side reconciliation.
8. **Push notifications do not route.** The payload carries `eventId`, but there is no
   `addNotificationResponseReceivedListener`; tapping a notification just opens the app. Route to the
   event/registration, and clear the badge on open.
9. **Phone is read-only in Profile** (`Row label="Phone" value={me.user.phone ?? "—"}`), with no edit
   or verification. This is the field users will most need to correct.
10. **Missing student conveniences:** add-to-calendar, share event, venue map/directions, favourite
    events, feedback after attendance, and a participation certificate generated from the report.
11. **Quiz answers are not saved as a draft.** A backgrounded app or a crash loses the attempt.
12. **No dark mode, no dynamic type.** Font sizes are fixed; respect the OS text-size setting and
    offer a dark theme (the tokens already exist).

### Features present (credit where due)

Discover/mine with search, filters and pagination; registration, withdrawal and waitlist position;
rotating QR passes; access and complaint scanning with identity check; offline scan queue with
deduplication; inbox; complaint filing and tracking; quiz attempts with server timer; profile,
password change, session sign-out, push registration.

---

## 5. Feature gaps worth naming

| Gap | Why it matters | Effort |
|---|---|---|
| SSO (Google Workspace / Microsoft Entra) | Students and staff will not maintain another password; this is the #1 adoption blocker | M |
| Setup wizard + CSV provisioning | Time-to-value for a new department/college | M |
| WhatsApp/SMS reminders | Email is not read in time for campus events | M |
| CSV/XLSX exports + `.ics` | Every coordinator asks for these on day one | S |
| Recurring events / series | Weekly club meetings are the common case | M |
| Certificates & post-event feedback | Closes the loop after attendance | M |
| Anonymous complaints | Safety reporting needs a lower-friction path | S |
| Global audit/support tools | Operability and trust | M |
| DPDP consent, retention, export/delete | Legal baseline in India; ID proofs are sensitive | M |
| Analytics (attendance, no-shows, resource utilisation) | The data is already there; operators cannot see trends | M |

---

## 6. Testing, CI and docs

- **API testing is a strength:** 360 tests, ~8.6k lines, including concurrency and contract parity.
- **Client testing is absent:** zero tests in `apps/web` or `apps/mobile`. The two crashes fixed in
  this project were exactly the class a component test or runtime schema parse would catch.
- **CI does not build or typecheck mobile**, does not run the Playwright scripts in `e2e/`, and has
  no coverage threshold or load test. The mobile app is the primary student surface; it should be a
  required CI job.
- **Add:** a Playwright smoke suite (login → event → register → pass → scan) against a seeded
  database, `expo export` for both platforms, a k6/artillery scan load test, and dependency/security
  scanning.
- **Docs:** unusually thorough (`architecture.md`, `deployment.md`, `security.md`, testing and
  troubleshooting guides), but the README still says "Phase 6 — awaiting review", the screenshots
  are pre-redesign, and `vercel.json` still contains `YOUR-API.onrender.com`. Fix the evidence before
  showing it to a reviewer.

---

## 7. What I would change, in order

### Next two weeks (hardening — do not run a real event before this)

1. Central PostgreSQL error → API status mapping; add a test that a constraint violation is not a 500.
2. Job token for cron + fix the deployment guide; use `/health/ready` for deploy gating; drain on
   shutdown.
3. Harden rate-limit identity; fail closed when proxy trust is misconfigured.
4. Mobile error boundary + runtime response validation from shared schemas.
5. One campus-timezone formatter used by web and mobile.
6. Finish the phone feature: E.164, verification, profile edit, use for reminders.
7. Add mobile typecheck/build and a Playwright smoke path to CI.
8. CSP + self-hosted fonts; regenerate screenshots; correct README status and Vercel host.

### Next four to six weeks (adoption)

9. OIDC SSO (Google/Microsoft) with domain-based role mapping, plus CSV staff/student import.
10. First-run setup wizard and an institution-wide audit/support view.
11. TanStack Query + real router + command palette + deep links on web.
12. Mobile UX pass: five tabs, pull-to-refresh, FlatList, network banner, haptics/brightness,
    push tap routing, offline pass fallback.
13. CSV/XLSX export, `.ics`/calendar links, public report verification.
14. `pg-boss` worker for PDFs/exports/outbox, Redis for rate limits and idempotency, outbound
    timeouts.
15. Sentry/OpenTelemetry, structured logs, metrics and alerting.

### Next quarter (product)

16. WhatsApp/SMS reminders and notification preferences.
17. Certificates, feedback, recurring events, anonymous complaints.
18. DPDP consent/retention/export-delete flows and a privacy notice.
19. Analytics for attendance, no-shows and resource utilisation.
20. Multi-tenant/white-label **only if** a second college is actually paying; until then, stay
    single-tenant and simple.

---

## 8. What I would *not* change

- **Per-permission approvals.** It is the most distinctive idea in the product; do not collapse it
  into one event approval.
- **Database-enforced resource exclusion and append-only audit.** Keep the invariants in Postgres.
- **Rotating, nonce-backed QR passes.** The security model is right; polish the day-of experience,
  don't weaken the tokens.
- **Immutable reports with checksums.** Add verification and exports around them, not mutable
  editing.
- **The warm "Ledger" design.** Refine accessibility and tokens; do not replace it with a generic
  dashboard theme.
- **The mobile-first student / management-web split.** It is coherent and defensible.
- **The monolith.** 19 modules in one deployable is correct at this stage; splitting into services
  would add failure modes without solving a real problem.
- **Bun + Hono + Drizzle + Postgres.** Do not rewrite the stack.

---

## Ship-readiness ruling

- **One-college pilot, 3–5k students, 100–300 events/term:** ship after the two-week hardening list,
  with a real event-day dry run on the actual venue Wi-Fi and a fallback process for scanner failure.
- **Paid multi-college product:** not yet. SSO, tenancy, support tooling, observability, privacy
  compliance and communications have to exist first.
- **As an engineering artefact:** top-tier. The domain modelling, constraints, tests and design voice
  are well above the usual bar; the remaining work is the unglamorous operational layer that turns a
  strong build into a dependable service.

---

## Hardening round 1 — what changed after this review

Landed on this branch, with the full gate re-run (360 API tests, lint and all four typechecks
clean; production web build green):

- **Operations:** structured JSON logs with request ids, request-scoped error mapping that no
  longer turns expected failures into 500s, proxy-aware client IPs (`TRUSTED_PROXY_HOPS`), and an
  idempotency ledger for retried writes.
- **Scheduling without external cron:** due maintenance runs on the first authenticated admin read
  (`MAINTENANCE_ON_REQUEST`, throttled by `MAINTENANCE_INTERVAL_SECONDS`), and the token-guarded
  `POST /api/v1/admin/jobs/maintenance` remains available for any scheduler.
- **Adoption:** an admin **Get started** checklist (`GET /admin/setup`) and a readable **Audit
  trail** (`GET /admin/audit`) in the console; global search now spans events, clubs and people;
  roster CSV export and per-event calendar (`.ics`) download.
- **Phone:** validated Indian phone input at registration, an editable phone on the mobile profile
  (`PATCH /me`), and normalised storage so lookups are consistent.
- **Web craft:** every create/edit/decision form is now a native `<dialog>` modal rather than an
  inline expanding div, with one shared `FormDialog`; dates render on the campus clock
  (`Asia/Kolkata`) instead of the visitor's locale.
- **Deployment:** CSP, HSTS and Permissions-Policy on the Vercel web tier; `.env.example` and the
  README now document the proxy, logging, maintenance and job-token variables with a working
  local-env path.

Deliberately still open: asynchronous PDF rendering (currently synchronous), cursor pagination
(offset pagination is correct at campus scale), SSO and multi-college tenancy (out of scope for a
single college), and client-side automated tests.
