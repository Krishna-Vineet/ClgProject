# CampusOps

Campus event operations for frequent short events: plan → permissions → resources → publish → register → verify → issues.

**Status:** production hardening. The full flow — permissions, resources, approvals, publication, registration, signed passes, scanning, complaints and reports — runs end to end on one connected codebase. The current round hardens the API (idempotency, maintenance, structured logs, proxy-aware rate limits), turns every create/edit form into a dialog, and adds search, audit, setup guidance and export/calendar links. 410 API tests pass (`bun run test`; five need the `btree_gist` exclusion constraint and only run on a database that has it).

**Audience split:** the website is management-only. Students (college and outside) use the mobile app; the event’s own coordinators and faculty scan with their normal login; there is no student web portal. An account with no staff role and no club membership is told to use the app.

- **Production review and next steps:** [`docs/product-review.md`](docs/product-review.md)
- **Phase 6 report:** [`docs/phase6-report.md`](docs/phase6-report.md)
- **Phase 6 critic audit:** [`docs/phase6-audit.md`](docs/phase6-audit.md)
- Phase 6 verification run: [`docs/phase6-verification.log`](docs/phase6-verification.log)
- **Phase 5 report:** [`docs/phase5-report.md`](docs/phase5-report.md)
- **Phase 5 critic audit:** [`docs/phase5-audit.md`](docs/phase5-audit.md)
- Mobile setup and versioning: [`docs/mobile.md`](docs/mobile.md)
- **Developer docs (start here):** [`docs/README.md`](docs/README.md) — getting started, monorepo, env, testing, deployment, troubleshooting, security
- Scope split for the two submissions: [`docs/evaluation-scope.md`](docs/evaluation-scope.md)
- **Phase 4 report:** [`docs/phase4-report.md`](docs/phase4-report.md)
- **Phase 4 critic audit:** [`docs/phase4-audit.md`](docs/phase4-audit.md)
- Phase 4 verification run: [`docs/phase4-verification.log`](docs/phase4-verification.log)
- Earlier audit and the report feature: [`docs/phase3-audit-and-reports.md`](docs/phase3-audit-and-reports.md)
- Latest verification run: [`docs/phase3-audit-verification.log`](docs/phase3-audit-verification.log)
- Sample report produced from live seeded data: [`docs/samples/sample-event-report.pdf`](docs/samples/sample-event-report.pdf)
- Earlier phase record: [`docs/phase3-report.md`](docs/phase3-report.md)

## Stack

- API: Bun + Hono + Drizzle + PostgreSQL (Neon-compatible)
- Web: React + Vite (deployable to Vercel)
- Mobile: Expo 58 / React Native 0.88 (connected student + organiser-scanner app; exact pins in `apps/mobile/package.json`)
- Shared: TypeScript contracts, Zod schemas, pure domain rules, role labels

## After a sandbox reset

Installed tooling and the local database do not survive a workspace reset; all
source, migrations, seed data and docs do. One command rebuilds the rest:

```bash
bash scripts/restore-sandbox.sh
```

**Keep the Bun binary outside `/home/user`.** A Bun binary inside the workspace
counts ~103 MB against the snapshot cap and silently stops new files from being
saved. This project installs it to `/usr/local/bin/bun` and keeps the package
cache in `/tmp/bun-cache`.

## Local setup

```powershell
bun install
cp .env.example .env.local
# Fill DATABASE_URL, JWT_ACCESS_SECRET and REFRESH_TOKEN_PEPPER.
# .env.local is loaded by both the API (Bun) and the web dev server (Vite),
# so one file is enough for local work.
bun run db:migrate
bun run db:seed        # optional demo data
bun run dev:api        # http://localhost:8787
bun run dev:web        # http://localhost:5173, proxies /api to the API
```

The web dev server proxies `/api` to the API. Browser code uses relative URLs only, so the same build works locally and behind one origin in production.

## Environment groups

Local development uses one root `.env.local`: server secrets stay server-side, and Vite exposes only `VITE_*` variables to the browser. The API port is `PORT`; the web proxy follows it automatically.

| Group | Variables | Notes |
|---|---|---|
| Database | `DATABASE_URL`, `DATABASE_URL_POOLED`, `DATABASE_DIRECT_URL` | Runtime prefers pooled; migrations prefer direct. Neon Auth is **not** used. |
| Auth | `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`, `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS` | Generate secrets locally; never commit them. |
| Demo | `DEMO_MODE`, `ALLOW_PRODUCTION_DEMO`, `EMAIL_MODE`, `EXPOSE_DEMO_OTP`, `SEED_DEMO_PASSWORD` | Demo email/OTP exposure requires explicit demo mode. |
| Email | `EMAIL_FROM`, `BREVO_API_KEY` or `RESEND_API_KEY` | `EMAIL_MODE=brevo` can use a verified single sender without a custom domain. |
| Storage | `STORAGE_MODE`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET` | Private S3-compatible storage for ID proof/photos; event report/export purposes unlock with their phases. |
| Approvals & resources | `RESOURCE_HOLD_TTL_HOURS` | How long an undecided resource hold survives (default 72). |
| Notifications | `NOTIFICATIONS_ENABLED`, `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS` | Transactional outbox; dispatched after commit with backoff. |
| Runtime | `TRUST_PROXY_HEADERS`, `TRUSTED_PROXY_HOPS`, `LOG_JSON` | Trust forwarding headers only behind a proxy that strips client values; set the hop count to match. `LOG_JSON=true` for hosted log collectors. |
| Jobs | `JOBS_ENABLED`, `JOB_INTERVAL_SECONDS`, `MAINTENANCE_ON_REQUEST`, `MAINTENANCE_INTERVAL_SECONDS`, `JOB_RUN_TOKEN` | The timer is optional. On a sleeping free host, due maintenance runs on the first admin read (`MAINTENANCE_ON_REQUEST=true`), or an external scheduler can POST `/api/v1/admin/jobs/maintenance` with `JOB_RUN_TOKEN`. |
| Access QRs | `QR_HMAC_SECRET`, `QR_TOKEN_TTL_SECONDS` | Rotating signed pass tokens (15–300 s, default 60). |
| Mobile | `EXPO_PUBLIC_API_URL`, `MOBILE_SCHEME` | Native builds need the absolute API origin; the browser preview uses a same-origin proxy. |

## Demo vs real behavior

- `EMAIL_MODE=demo` logs email metadata and returns a 6-digit OTP in the API/UI when `EXPOSE_DEMO_OTP=true`. No real email is sent.
- `EMAIL_MODE=brevo` / `resend` sends real email and never returns the OTP in the response.
- `STORAGE_MODE=disabled` returns `503 STORAGE_DISABLED` for file operations; it does not silently fake uploads.
- `STORAGE_MODE=s3` uses private buckets, short-lived signed upload/download URLs, server-side HEAD validation, and DB file references.
- Seed accounts are fake. Demo-account login is disabled unless `SEED_DEMO_PASSWORD` is set locally.
- Quiz-ranked admission (`QUIZ_TOP_N`, `QUIZ_FIRST_QUALIFIED`) uses the event quiz and never silently degrades to first-come-first-served when no quiz is configured.

## Commands

```bash
bun run lint
bun run typecheck
bun run test          # uses apps/api/bunfig.toml preload; requires TEST_DATABASE_URL
bun run build:web
bun run build:mobile:web   # static Expo web export for the mobile review preview
bun run preview:mobile
bun run db:check
bun run jobs:run      # one maintenance pass: hold expiry, lifecycle, outbox, pruning
```

Real-browser walkthrough (needs the API and web dev server running, plus a seeded demo password):

```bash
E2E_PASSWORD="$SEED_DEMO_PASSWORD" bun run e2e:all
# individually: bun run e2e:access      (access QRs, complaint posters, club faculty)
#               bun run e2e             (event lifecycle + reports)
#               bun run e2e:management  (admin, clubs, resources, verification, event ops)
E2E_PASSWORD="$SEED_DEMO_PASSWORD" bun run e2e:mobile   # needs the mobile preview on :8081
```

If Playwright's browser download is blocked, install Chromium and point at it:
`E2E_CHROMIUM_PATH=/usr/bin/chromium`.

## API surface

OpenAPI 3.1 is served at **`GET /api/v1/openapi.json`**, generated from the same Zod schemas the routes validate with. A parity test asserts every mounted route is documented and every documented operation exists.

| Area | Routes |
|---|---|
| Meta | `/health/live`, `/health/ready`, `/config`, `/openapi.json` |
| Auth | `/auth/*`, `/me`, `/me/export`, `/me/delete` |
| Files | `/files/config`, `/files/presign`, `/files/:id/complete` (magic-byte checked), `/files/:id/download` |
| Admin | `/admin/users*`, `/admin/users/:id`, `/admin/staff`, `/admin/staff/:id` (PATCH), `/admin/programs`, `/admin/jobs`, `/admin/jobs/maintenance` |
| Departments | `/departments` (GET/POST), `/departments/:id` (PATCH) |
| Faculty | `/faculty/verification-queue`, `/faculty/students/*` |
| Clubs | `/clubs/*`, `/clubs/:id/candidates`, `/clubs/:id/members*`, `/me/clubs` |
| Events | `/events`, `/events/:id`, `/submit`, `/revisions`, `/publish`, `/cancel`, `/start`, `/complete`, `/eligibility-preview`, `/invitations`, `/audit`, `/me/events` |
| Approvals | `/approvals/inbox`, `/approvals/approvers`, `/approval-requests/:id`, `/decision`, `/escalate`, `/reassign`, `/cancel`, `/resources` |
| Resources | `/resources`, `/resources/availability`, `/resources/calendar`, `/resources/:id/units`, `/resource-units/:id` |
| Reports | `/events/:id/reports` (POST/GET), `/events/:id/report-preview`, `/events/:id/reports/:reportId`, `/events/:id/reports/:reportId/pdf` |
| Access | `/events/:id/checkpoints` (GET/POST), `/access/checkpoints/:id` (PATCH/DELETE), `/events/:id/passes`, `/events/:id/passes/issue`, `/access/passes/:id/revoke`, `/events/:id/access-log`, `/access/scan`, `/me/passes`, `/me/passes/:id/nonce` |
| Complaints | `/events/:id/complaint-locations` (GET/POST), `/complaints/locations/:id` (GET/PATCH), `/complaints/locations/:id/poster`, `/complaints/locations/:id/reports`, `/events/:id/complaints`, `/events/:id/complaints/summary`, `/complaints/:id` (GET/PATCH) |

Two routes carry role-scoped access beyond the ADMIN router:

| Route | Admin | HOD/Dean |
|---|---|---|
| `GET /admin/staff` | every staff member | own department only (`departmentId` outside the scope → 403) |
| `GET /admin/programs` | every programme | programmes whose home *or* foundation department is in scope |
| `PATCH /admin/staff/:id` | any field, including department, designation, position and employee code | name, phone, email only; structural keys → 400, another department's member → 403 |

`GET /me/export` returns everything held about the caller (including which consent-policy version they accepted). `POST /me/delete` anonymises the account in place: identifiers are overwritten and sessions destroyed, while attendance and complaint history stay readable because other people's records depend on them.

### Post-event reports

`POST /events/:id/reports` files an immutable snapshot and returns a PDF built from it. Access is institutional: the event's coordinators, faculty who acted on its approvals, the club's faculty members, HOD/Dean **in that department**, and Admin.

- Each generation creates a new numbered version; a database trigger rejects UPDATE on an issued report.
- The snapshot is checksummed (SHA-256 of canonical JSON). Downloads refuse to issue a report that fails verification.
- Attendance totals come from SQL aggregates and stay exact even when the listed rows are capped by `REPORT_MAX_ATTENDEES`; the report says when it is capped.
- With no QR checkpoints the report states that figures are registrations only and makes no claim about physical presence.
- With `STORAGE_MODE=disabled` the PDF is re-rendered from the stored snapshot on download, and the response says it was not archived.

### Event access QRs

Defined per event in the web portal, before publish or while the event is running. A **checkpoint** is one scannable thing — entry, exit, the meal hatch, book issue, a session.

- `maxUses` is the **total** redemptions one participant may make at that checkpoint for the whole event: `null` for unlimited entry/exit, `1` for a meal or the DJ, `3` for book issue.
- `isActive` is the live switch. A meal QR is refused while the counter is closed, even on a participant's first use.
- `requiresIdCheck` makes the scanner confirm the person matches their college ID, so nobody attends on someone else's behalf.
- Passes are issued to CONFIRMED registrations (`POST /events/:id/passes/issue`, idempotent) and can be revoked individually.
- The participant's app fetches `GET /me/passes` and mints a short-lived rotating code per checkpoint with `POST /me/passes/:id/nonce`. The code is HMAC-signed and its nonce is consumed on first scan, so a screenshot cannot be replayed.
- **Scanning is done by the event's own coordinators and club faculty** with their normal login (`POST /access/scan`). There is no separate scanning-staff role.
- Every scan records the participant, the checkpoint, the scanner, the timestamp, the outcome and the reason. Two gates cannot both grant the last turn: the pass row is locked before counting.

Set `QR_TTL_SECONDS` (15–300, default 60) and optionally `QR_SIGNING_SECRET` to rotate QR signing independently of sessions.

### Complaints

Coordinators create a reporting point per location, including ad-hoc spots, and download a printable **A4 PDF poster** (`GET /complaints/locations/:id/poster`) carrying the QR, the location, the event title and date, and the club name. Students scan it in the app and report; only a confirmed registrant of that event (or its organisers) can raise one.

Reports land in that event's inbox only. Organisers assign, progress and resolve them with a note; every change is kept as a handling trail the reporter can read. `COMPLAINT_QR_BASE` sets the deep link encoded in the poster.

### Concurrency contract

- Event mutations require `expectedRevision`; a stale value returns 409.
- Approval mutations require `expectedVersion`; a stale value returns `409 STALE_APPROVAL_VERSION`.
- Resource overlap is rejected by a PostgreSQL exclusion constraint as `409 RESOURCE_CONFLICT`, not by an application-level check.
- Publishing requires every required approval granted and live confirmed reservations, else `422 APPROVAL_REQUIRED`.
- Registration/event creation and a few other mutations accept an `Idempotency-Key`; replaying a key with a different payload returns `409 IDEMPOTENCY_CONFLICT`.

## Deployment shape

Web on Vercel; API on a Bun-capable host (Render supports Bun natively — pin the version with `.bun-version`); PostgreSQL on Neon. Keep `JOBS_ENABLED=false` on hosts that sleep and drive maintenance from cron or `POST /api/v1/admin/jobs/maintenance`. Rationale and free-tier caveats are in [`docs/phase3-report.md`](docs/phase3-report.md#6-hosting-recommendation-bun-api).

## Known limitations

- Access QRs, announcements, complaints, quizzes, push and offline scanning are implemented. See [`docs/evaluation-scope.md`](docs/evaluation-scope.md) for the evaluation split.
- The web console is management-only by design. The mobile app connects registration, passes, organiser inspection/scan, complaints, quizzes and profile/password flows, including phone-number updates.
- `RATE_LIMIT_SCALE` defaults to 1 and must stay 1 in production. Raise it only for a local test session, where many sign-ins legitimately come from one address.
- `bun audit` still reports a high-severity Zod advisory (CVE-2023-54404) patched only in Zod 4. The exposure — array schemas without a length cap — is closed in every request schema; the migration itself is outstanding. See [`docs/phase4.5-audit.md`](docs/phase4.5-audit.md).
- S3 and Brevo code paths exist and fail loudly when unconfigured, but have **not** been exercised with real credentials.
- A Bruno collection is not generated; the OpenAPI document and contract tests are the current contract source.
- Create/edit forms in the web console are native `<dialog>` modals. Long tables remain offset-paginated; cursor pagination is a future improvement, not a correctness issue at campus scale.
- The API is a long-lived Bun/Hono server and cannot run on Vercel serverless.
