# Phase 3 — Events, Approvals and Resources

**Status: complete and verified.** Gate evidence: [`phase3-verification.log`](./phase3-verification.log).

Phase 3 turns CampusOps from an account system into the event engine the whole
product rests on. Everything below runs against real PostgreSQL 17, and the
approval flow was additionally driven end-to-end in a real Chromium browser.

---

## 1. The four gate criteria

The blueprint names four things that must be provably true. Each one has a test
that fails if the guarantee breaks.

| Gate | Result | Evidence |
|---|---|---|
| An overlapping resource request fails | **Pass** | `RESOURCE_CONFLICT` (409) from the PostgreSQL exclusion constraint. 20 parallel submissions for one unit produce **exactly one** active hold and 19 conflicts. No partial bundle survives a conflict. |
| An event cannot publish with a required pending request | **Pass** | `APPROVAL_REQUIRED` (422). Verified in the API and in the browser: the Publish button is disabled, and the server refuses independently. |
| A stale approval action fails | **Pass** | `STALE_APPROVAL_VERSION` (409) on `expectedVersion` mismatch. 8 parallel decisions on one request produce **exactly one** effective action; replays are blocked. |
| Escalation preserves history | **Pass** | Action log reads `SUBMIT → ESCALATE → ESCALATE → APPROVE` across tiers `FACULTY → SENIOR → ADMIN → ADMIN`. Nothing is overwritten. Confirmed visually in the browser timeline. |

The concurrency guarantees come from the database, not from application luck:

- **Resource overlap** — `EXCLUDE USING gist (resource_unit_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status IN ('HELD','CONFIRMED'))`. Two transactions cannot both hold the same unit for overlapping time, regardless of what the API does.
- **Approval decisions** — `SELECT … FOR UPDATE` on the request row plus a version check inside the same transaction.
- **One current bundle per event** — partial unique index on `event_id WHERE superseded_at IS NULL`.
- **One ORGANIZE / one INVITE_OUTSIDERS per bundle** — partial unique indexes, so a bundle cannot be composed incorrectly even by a buggy client.

---

## 2. What was built

### Event lifecycle
`DRAFT → PENDING_APPROVALS → READY → PUBLISHED → LIVE → COMPLETED`, with
`CANCELLED` reachable from any state and a `DRAFT` fallback when changes are
requested. Edits are allowed only in `DRAFT`; every mutation carries
`expectedRevision`. A critical change after publication creates a **new draft
revision** and supersedes the old approval bundle rather than silently reusing
approvals that were granted for different facts. Description and banner changes
are cosmetic and do not force re-approval.

Revisions are immutable snapshots with `changed_fields` and a note, so "what
exactly did the approver agree to?" always has an answer.

### Individual approvals, never merged
A bundle groups requests visually; each request is decided on its own. Exactly
one required `ORGANIZE` request, plus a required `INVITE_OUTSIDERS` request
whenever the audience is not college-only. An optional request being rejected
does not block publication; a required one does.

### The college's actual escalation path
`FACULTY → SENIOR (HOD/Dean) → ADMIN`, one step at a time. A coordinator asks any
faculty member; that faculty member approves, requests changes, reassigns to
another faculty member, or escalates. HOD/Dean can escalate once more to Admin.
Admin is the top of the chain and cannot escalate further.

Authority is enforced per tier: at `FACULTY` only the named assignee may act; at
`SENIOR` any HOD/Dean **within the club's department**; at `ADMIN` any admin. An
admin cannot reach down and decide a faculty-tier request, and a HOD/Dean from
another department gets 403.

### Resources
Catalog → units → availability → holds. Submitting a resource request creates a
`HELD` reservation; approval makes it `CONFIRMED`; rejection, withdrawal,
cancellation or expiry releases it. Holds carry a TTL (`RESOURCE_HOLD_TTL_HOURS`,
default 72) so an unanswered request cannot block a lab forever. Availability
shows other events only as anonymous busy blocks — never their titles or owners.
A unit with upcoming bookings cannot be quietly retired or put into maintenance.

### Audit history
`GET /events/:id/audit` returns append-only, redacted history. Faculty see
approval history for the event, not unrelated club administration. A coordinator
from another club gets 404. The table has `BEFORE UPDATE`/`BEFORE DELETE` triggers
that reject mutation — a test asserts both raise, and an attempted demo-data
cleanup during this phase was correctly refused by them.

### Notifications and jobs
Notifications are queued in a **transactional outbox** in the same transaction as
the business change, then dispatched after commit with `FOR UPDATE SKIP LOCKED`,
exponential backoff and a terminal `FAILED` state. Maintenance jobs (hold expiry,
lifecycle advance, outbox dispatch, pruning) run under a PostgreSQL advisory lock
so overlapping runs cannot double-process. They can run as an in-process timer
(`JOBS_ENABLED`), as `bun run jobs:run` from cron, or via
`POST /api/v1/admin/jobs/maintenance`.

### Web portal
A working coordinator/approver console, not a mock: create a draft, pick a
faculty approver, pick only genuinely free resource units, submit, review,
approve, request changes, reassign, escalate, and publish. Approvers see role
names ("HOD/Dean"), never internal tier codes. Students see none of this tooling.

### API contract
OpenAPI 3.1 at `GET /api/v1/openapi.json`, generated from the **same Zod schemas
the routes validate with** — 69 paths, 79 operations. A parity test asserts every
mounted route is documented and every documented operation is actually mounted,
so the document cannot drift.

---

## 3. Verification

| Check | Result |
|---|---|
| Biome lint/format | Clean, 114 files |
| TypeScript (shared, api, web) | 0 errors, all three packages |
| Unit + integration tests | **105 pass / 0 fail / 640 assertions / 12 files** |
| Real-browser walkthrough | **21 pass / 0 fail**, no console errors |
| Web production build | Succeeds |
| Fresh DB migrate + seed | `0001`–`0004` apply cleanly; seed idempotent |
| Schema invariants | 45 tables, exclusion constraint present, 4 Phase 3 partial indexes, 2 append-only triggers |

Test files: `domain` (26 pure-rule tests), `phase3.integration` (33), `openapi` (8),
`web-contract` (7), plus the Phase 1/2 suites carried forward.

---

## 4. Bugs found and fixed during this phase

These were caught by verification, not assumed away:

1. **Wildcard auth middleware leaked across the API.** Mounting the audit router at `/api/v1` applied its `authenticate` middleware to *every* API path, turning unknown-route 404s into 401s. Fixed by registering the audit handler on `eventRoutes` behind its own scope guard. The existing contract test caught it.
2. **Web client sent the wrong field names.** The approval panel sent `decision` instead of `action`, omitted `toTier` on escalation, and used `assignedApproverId` instead of `assigneeId` on reassignment — all 400s in the browser. Fixed, and a new `web-contract` test now validates the payloads the React panels actually send against the real Zod schemas, so this class of bug fails in CI rather than in a demo.
3. **Publishing a draft returned a generic conflict.** Now returns `APPROVAL_REQUIRED` with "Submit this revision for approval before publishing."
4. **A no-op domain stub.** `validateAdmissionForAudience` returned `[]` for every input. It now refuses quiz-ranked admission until a quiz is attached, so an event can never be created that could not admit anyone. The form only offers FCFS and MANUAL until Phase 7.
5. **`/me` did not expose roles or memberships**, so the portal could not decide which tools to show. Added, with a test asserting no password material ever leaves the API.
6. **Seed data violated the new Phase 3 CHECK constraints** on a fresh database (approved requests without `decided_by`, confirmed reservations without `confirmed_at`). Fixed and proven on a brand-new database.

---

## 5. Deliberate boundaries

- **Quiz-ranked admission** is refused, not faked. It unlocks in Phase 7 when quizzes exist.
- **Registrations, attendance QR, complaints** are Phase 4–7. The portal says so rather than showing dead buttons.
- **S3 and Brevo have never been exercised with real credentials.** The code paths exist and fail loudly when unconfigured; they are not claimed as tested. You will add the Brevo key yourself and manual-test before the debugging phase.
- **The job timer is off by default** because free hosts sleep. Use cron or the admin endpoint in production.

---

## 6. Hosting recommendation (Bun API)

**Recommendation: Render for the Bun API, Neon for PostgreSQL, Vercel for the web app.**

Render supports Bun natively. Bun is included when you set `BUN_VERSION`, add a
`.bun-version` file, or commit `bun.lock` — this repo already commits `bun.lock`.
Pin the exact version rather than using `latest`; the repo standardises on Bun
1.4.4, which is also Render's default for services created on or after
2026-10-22. [1](https://render.com/docs/bun-version)

Suggested setup:

| Piece | Host | Notes |
|---|---|---|
| API (Bun + Hono) | Render web service | Build `bun install`; start `bun run apps/api/src/index.ts`. Add `.bun-version` = `1.4.4`. |
| PostgreSQL | **Neon** (your account) | Do **not** use Render's free Postgres — it expires 30 days after creation. |
| Web (React/Vite) | Vercel | Static build; proxy `/api` to the Render API. |
| Jobs | Render cron or `jobs:run` | Keep `JOBS_ENABLED=false` on a free instance. |

Free-tier caveats that matter for this project: Render free web services spin
down after 15 minutes without inbound traffic (~1 minute cold start), have an
ephemeral filesystem, and share 750 instance-hours per workspace per month.
Render also documents that a free service initiating high outbound traffic —
explicitly including external database and external API calls — may be
suspended, which is exactly the Neon + Brevo pattern.
[2](https://render.com/docs/free)

That makes Render's free tier fine for evaluation demos but risky for a live
campus event where a cold start lands in the middle of check-in. For the actual
event day, the cheapest reliable shape is a small always-on paid instance (or a
$5–6/month VPS) with Neon still handling the database. Railway, Fly.io and Koyeb
no longer offer a comparable permanent free backend tier, so they are not
better free options today.

The API cannot run on Vercel serverless — it is a long-lived Bun/Hono server with
a connection pool and a job timer, which is why the web and API are split.

---

## 7. Suggested next step

Phase 4: registrations and the student-facing web portal — event discovery,
eligibility-aware registration, admission modes, and the coordinator's attendee
list. Phase 3's approval and resource guarantees are the foundation it builds on.
