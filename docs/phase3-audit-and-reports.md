# Phase 3 audit + post-event reports

Audit performed before starting Phase 4, as required. Every defect below was
reproduced by a test before being fixed, and the fix is covered by a permanent
regression test.

**Final state:** lint clean (121 files) · typecheck clean (3 packages) ·
**125 tests pass / 0 fail / 785 assertions / 14 files** · web build clean ·
**real-browser walkthrough 32 pass / 0 fail, no console errors** ·
fresh database migrates 0001–0005 and seeds idempotently.

---

## Part 1 — defects found and fixed

### Critical: two features could not be used at all

**1. Event banners were impossible to attach.**
`events` requires a banner file with purpose `EVENT_BANNER`, but the presign
endpoint rejected every purpose except `PROFILE_PHOTO` and `COLLEGE_ID_PROOF`
with the message *"This file purpose is not open in Phase 2."* The gate was never
updated when Phase 3 shipped, so the two halves of the feature contradicted each
other.

*Fix:* direct upload now accepts the shared `UPLOADABLE_FILE_PURPOSES` list
(profile photo, ID proof, event banner). `EVENT_REPORT` is refused with a message
pointing at the server-side generation endpoint, because reports must not be
uploadable by a client.

**2. `completeEvent` accepted `reportFileId` and silently discarded it.**
The schema advertised the field; the service never read it and no column existed.
A coordinator could "attach" a report and be told the event completed
successfully while the reference vanished.

*Fix:* removed the field. `completeEventSchema` is now `.strict()`, so sending it
returns 400 instead of lying. Real reports have their own endpoint.

### Correctness

**3. OpenAPI advertised pagination the routes did not implement.**
`/faculty/verification-queue` and `/clubs` documented a `cursor` parameter, while
both routes actually parsed `limit`/`offset`. A client following the document
would send `cursor` and get an unpaginated first page forever.

*Fix:* both routes now use the shared `offsetPaginationSchema`, the manifest
advertises the same schema, and the unused cursor schema was deleted rather than
left as a misleading contract. A test asserts the advertised style matches.

**4. The report counted a student coordinator as "faculty involved".**
The first implementation treated every approval action — including `SUBMIT` — as
faculty involvement, so the club lead who filed the request appeared in the
faculty table. Caught by reading the generated PDF, not by the tests.

*Fix:* only decisions and escalations count (`APPROVE`, `REJECT`,
`REQUEST_CHANGES`, `ESCALATE`, `REASSIGN`), and only `STAFF` accounts are listed.
Regression test asserts the submitting coordinator is absent and every listed
person is a staff account.

**5. Report attendance counts would have been wrong for large events.**
Counts were derived from the same rows used to build the attendee list, so
capping the list would silently understate attendance.

*Fix:* totals come from SQL aggregates (`GROUP BY status`, and
`COUNT(DISTINCT registration_id)` for check-ins) and stay exact regardless of the
list cap. When the list is capped, both the PDF and the UI say so explicitly.
Test forces a cap of 1 against 3 registrations and asserts the summary still
reports 3.

**6. The report's PDF archive wrote outside its own transaction.**
The S3 helper inserted the `files` row on a separate connection while the report
transaction was open, so a rollback would orphan a file record.

*Fix:* network I/O happens before the transaction; the `files` row is inserted
inside it; if the transaction fails, the uploaded object is deleted best-effort.

**7. Reports UI race conditions.** Two bugs found by the browser walkthrough:
- Selecting an event fired a request to `/events//reports/...` because the handler
  read `eventId` from state immediately after setting it. Fixed by passing the id
  explicitly.
- An older report's response could overwrite a just-generated one. Fixed with a
  monotonic sequence guard on every load.

### Hardcoding removed

| Was | Now |
|---|---|
| `.limit(50)` in the notification fan-out | `OUTBOX_FANOUT_MAX` |
| `.limit(500)` in event invitations | `INVITATION_LIST_MAX` |
| `.limit(200)` in resource availability | `RESOURCE_AVAILABILITY_MAX_UNITS` |
| `.limit(200)` in the approver directory | `APPROVER_DIRECTORY_MAX` |
| Attendee rows unbounded | `REPORT_MAX_ATTENDEES` (default 2000) |
| `CAMPUS_TIMEZONE` duplicated as a dead shared constant | `DEFAULT_CAMPUS_TIMEZONE`, env-overridable |
| `QR_TTL_SECONDS` a dead shared literal | `QR_TTL_SECONDS` env var with a shared default |
| `FILE_PURPOSES` listed 3 of the DB's 6 values | all 6, plus a separate uploadable subset |
| Presign purpose enum duplicated in the OpenAPI manifest | generated from the shared list |
| Local `pageSchema` literals in two routers | shared `offsetPaginationSchema` |
| Playwright imported from an absolute cache path | normal import + `E2E_CHROMIUM_PATH` |

All new variables are documented in `.env.example` and validated at startup.

### Presentation

- PDF typography folded to `?` for em-dashes, quotes and bullets. Now
  transliterated properly; only genuinely unsupported scripts fall back.
- Department names truncated uselessly in the attendee table; the report now
  carries and prints the department code.
- The web app had no favicon (a 404 on every page load) and its title still said
  "Phase 1". Both fixed.

### Workspace

The Bun binary (103 MB) was inside the snapshot path and silently blocking saves.
Moved to `/usr/local/bin/bun`; the workspace is now **12 MB** with all source,
docs and logs present. `scripts/restore-sandbox.sh` reproduces the environment
after a reset.

---

## Part 2 — what was checked and found sound

- **No deprecated APIs.** No `substr`, `escape`, or legacy Node patterns.
- **No stubs or TODOs** in shipped code paths.
- **All 30 PostgreSQL enums match the Drizzle definitions exactly**, verified
  programmatically against the live database rather than by grepping migrations.
- **Approval bypass:** resources cannot be attached to an already-approved
  request; adding a required request re-locks a READY event.
- **Resource integrity:** publishing confirms every reservation it validated;
  cancelling releases confirmed reservations; the exclusion constraint prevents
  double booking under concurrency.
- **Visibility:** a college-only event is invisible to an outsider in the list,
  in detail, and across all four operational sub-resources.
- **Audit trail:** append-only at the database level for both UPDATE and DELETE.

---

## Part 3 — post-event reports

Built to the agreed decisions: **institutional access, instant generation with no
sign-off, PDF only**, covering the approvals trail, resource usage and attendance.

### What a report contains

1. **Event** — title, type, status, date and time, venue, audience, admission
   mode, capacity, revision, publication and completion timestamps, and the
   cancellation reason if it was cancelled
2. **Description** — and the job description for placement-style events
3. **Organised by** — the club, its department, every active coordinator with
   their role, and the faculty advisor
4. **Permissions and approvals** — each permission separately, with its final
   status, who decided it, when, and the complete action trail including every
   escalation and comment. This answers *under whose permission the event ran*
5. **Faculty involved** — every staff member who decided or escalated, with the
   tiers they acted at
6. **Resources used** — resource, unit, code, window and final status
7. **Attendance summary** — registered, confirmed, waitlisted, cancelled,
   rejected, capacity, fill rate, and QR check-in count and rate when available
8. **Attendee list** — name, roll number, department, status and check-in time
9. **Coordinator notes** — free text recorded at generation
10. **Record integrity** — who generated it, when, and a SHA-256 checksum

### Guarantees

- **Immutable.** Each generation stores a full snapshot. A database trigger
  rejects UPDATE, so an issued report can never be quietly edited. Regenerating
  files a new numbered version.
- **Verifiable.** The snapshot is checksummed with canonical JSON. Reading a
  report recomputes the checksum; a mismatch is reported, and the PDF endpoint
  refuses to issue a report that fails verification.
- **Access-controlled.** Coordinators of that club, faculty who actually acted on
  its approvals, the club's faculty advisor, HOD/Dean **within that department**,
  and Admin. An uninvolved faculty member and a HOD/Dean from another department
  both get 404 — and the PDF endpoint is protected identically, not just the JSON.
- **Honest about what it cannot prove.** If no QR checkpoints existed, the report
  says attendance reflects confirmed registrations only and makes no claim about
  physical presence. If object storage is disabled, it says the PDF was not
  archived and is re-rendered on demand. If the attendee list is capped, it says
  so while keeping the totals exact.
- **Timing enforced.** A report cannot be issued before the event ends. Cancelled
  events can still be reported on, because a cancellation is also a record.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/events/:id/reports` | Generate and file a new version |
| GET | `/events/:id/reports` | List filed versions |
| GET | `/events/:id/report-preview` | Preview without filing |
| GET | `/events/:id/reports/:reportId` | Read a snapshot and verify its checksum |
| GET | `/events/:id/reports/:reportId/pdf` | Download the PDF |

Generation is rate-limited to 10 per minute per caller. PDF rendering uses
`pdf-lib` — pure JavaScript, no headless browser, so it runs on Bun and on a small
host without extra system dependencies.

### Demo data

The seed now includes a genuinely completed event (`Applied ML Recap Session`)
with an escalated approval trail, two released resource bookings, two
registrations and a real gate check-in. The Reports area therefore demonstrates
the whole feature on a fresh install, and the sample PDF in
`docs/samples/sample-event-report.pdf` was generated from that live data, not
from hand-written fixtures.

---

## Test coverage added this round

**`tests/reports.integration.test.ts` — 10 tests**
captures permissions/club/coordinators/faculty/attendees · submitting coordinator
is not misreported as faculty · the PDF is a real readable document · regeneration
creates a new version without editing the old · the database refuses to rewrite an
issued report · institutional access is enforced for faculty, other departments,
unrelated clubs and the PDF endpoint · reports are refused before the event ends ·
preview files nothing · counts stay exact when the list is capped · disabled
storage is stated rather than faked.

**`tests/audit-probe.test.ts` — 10 tests**
publish confirms reservations · no post-approval resource attachment · required
request re-locks a READY event · cancellation releases reservations · college-only
visibility · the complete-event contract is not a lie · advertised pagination
matches runtime · banners can be presigned · server-generated purposes are refused
for upload · operational caps come from configuration.

**`e2e/portal.mjs` — 32 browser checks**, now including report generation, every
report section rendering, a real PDF download verified by its `%PDF-` header, the
timing gate, and access denial for uninvolved faculty.

---

## Still not claimed

- **Real S3 and Brevo have never been exercised with live credentials.** The code
  paths are written and fail honestly when unconfigured; the user will add the
  Brevo key and test manually before the debugging phase.
- The rate limiter has no dedicated load test.
- Bruno request-collection parity is not asserted automatically.
- E2E test events accumulate in the development database by design: the
  append-only audit trail intentionally prevents deleting them. Reset the database
  for a clean demo.
