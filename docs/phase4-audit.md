# Phase 4 critic audit — management website

Audit performed after the Phase 4 build, before delivery. Every finding below was
reproduced (by a test, a browser run, or a direct API call), fixed, and re-verified.
Findings I introduced myself during the phase are marked **[self-inflicted]** — they
are listed because an audit that only reports the convenient bugs is not an audit.

Evidence for the final state: [`phase4-verification.log`](phase4-verification.log).

---

## A. Correctness and security

### A1. Staff setup called the wrong endpoint — accounts could never activate
The new `AuthPanel` "setup" tab posted the setup code to `/auth/verify-email`, which
only consumes `EMAIL_VERIFICATION` tokens. `STAFF_SETUP` tokens are consumed by
`/auth/reset-password`, which also sets the first password and flips the account to
`ACTIVE` + `emailVerifiedAt`. As written, a newly provisioned staff member could not
activate at all.

**Fix:** one "Enter a code" flow posts `{email, otp, newPassword}` to
`/auth/reset-password`. The token purpose, not the UI, decides whether it is a reset
or a first-time activation. Removed the invented "challenge ID" field.

### A2. Password change left a dead screen
`changePassword` revokes **every** session including the caller's, and the auth
middleware checks `sessions.revokedAt` on every request. The panel said "other
sessions were signed out" and stayed on screen, so the next click would 401.

**Fix:** the panel ends the local session and returns to sign-in, with copy that
says so. Also removed a dead `throw new Error("ignored")` branch on mismatch.

### A3. Provisioning opened the wrong user
`AdminPanel.provision()` opened `rows[0]?.id` — the first row of the *old* list —
instead of the account just created.

**Fix:** capture `res.user.id` and open that.

### A4. Plain students could enter the management console
The scope decision is explicit: the website is for coordinators, clubs, faculty,
HOD/Dean and Admin. A college student with no club role signed in and got the
Resources and Account tabs.

**Fix:** `mayUseConsole = isStaff || isCoordinator`. Anyone else gets a card telling
them to use the mobile app, no navigation, and a sign-out button. Covered by a
browser assertion using an **outsider** account, which can never hold a club
membership, so the check stays valid after other suites grant coordinator roles.

### A5. UI offered controls the API refuses (two cases)
Both were found by driving the UI as the affected role, not by reading code.

| Control | API guard | Symptom | Fix |
|---|---|---|---|
| "Add resource" → *Institution-wide* | HOD/Dean must target a department in scope | 403 on submit | Department is required and pre-selected from `scopedDepartmentIds`; institution-wide offered to Admin only |
| "Open college ID proof" / "Open photo" | `/faculty/students/:id/files/:fileId/download` is `FACULTY`-only | 403 on click | Both buttons gated to faculty; HOD/Dean gets an explanatory line and still reviews the submitted details |

The audit also confirmed the cases that were already right: club creation is
Admin-only in both API and UI; club member management derives `canManage` from the
server's response rather than guessing from roles; resource unit writes use the
server-supplied `canManage` flag.

### A6. A revoke button that did nothing
`EventWorkspace` defined `doRevoke()` and a `revoke` state, but never rendered the
confirmation dialog. Clicking **Revoke** on an invitation set state and nothing else
happened. **[found by browser test]**

**Fix:** rendered the `ConfirmDialog`. The browser suite now asserts the dialog
opens, the row becomes `Revoked`, and the destructive path is confirmed explicitly.

### A7. A read failure disguised as a permission state
`ClubsPanel` treated *any* error from `/clubs/:id/members` as "you are a read-only
viewer", so a 500 or a dropped connection silently removed the management controls.

**Fix:** only `403` means read-only; anything else surfaces as an error toast.

---

## B. Rendering and UX

### B1. Errors rendered with a class that does not exist
`EventWorkspace` used `className="error-note"`; the stylesheet defines `bad-note`
(through the shared `ErrorNote`). Every error in the newest panel was unstyled text.

**Fix:** use `ErrorNote`. Added an automated check that compares every
`className="…"` literal against the stylesheet — it now reports zero undefined
classes.

### B2. `.stack` was used by three panels but never defined
Added it — which then caused **B3**. **[self-inflicted, caught by the browser suite]**

### B3. The new grid caused 415px of horizontal overflow at a 420px viewport
`display: grid` sizes tracks to min-content, so a wide table pushed the page wider
than the screen instead of scrolling inside `.scroll-x`.

**Fix:** `.stack > * { min-width: 0 }`, `.scroll-x { max-width: 100% }`, and
`overflow-wrap: anywhere` for long JSON in table cells. The suite asserts zero page
overflow at 420px.

### B4. A column bound to a field that does not exist
`AdminPanel` typed job runs as `{status: string}` and rendered `{r.status}`. The
`job_runs` table has **no status column** — it has `startedAt`, `finishedAt`,
`processed`, `detail`. The column had always been silently blank; when the audit
"humanised" it with `.replace()`, the whole Maintenance panel crashed.
**[self-inflicted crash, caught by the browser suite]**

**Fix:** typed against the real schema; state is derived (`finishedAt ? Finished :
Running`) and a **Processed** column was added. This is the second time a web type
drifted from an API response, so the audit now treats "typecheck passes" as
insufficient for response shapes.

### B5. A false empty state while loading
`ReportsPanel` rendered "No completed or cancelled events yet" during the initial
fetch, which is a different claim from "still loading".

**Fix:** explicit loading state; the select is disabled and reads "Loading events…".
The browser test also stopped racing the dropdown (see C2).

### B6. The main event list was silently capped
The coordinator's primary table fetched `limit: 50` with no pager and no filter. For
a club running frequent one-day events, event 51 simply did not exist.

**Fix:** status filter, total count, and offset pagination at the shared page size.

### B7. Raw enum values shown to users
Resource and unit statuses rendered as `MAINTENANCE` / `RETIRED`.

**Fix:** added `RESOURCE_STATUS_LABELS` to shared (one map — resources and units use
the same enum) and tightened the web types from `string` to `ResourceStatus`, which
is what made the remaining unsafe lookups a compile error. Reservation status in
reports now uses the existing `ReservationBadge`.

### B8. Delivery phase hardcoded in five places
Health, readiness and the root banner each said `phase: 3`, so the console header
claimed Phase 3.

**Fix:** one `IMPLEMENTATION_PHASE` constant in shared, currently `4`.

---

## C. Test quality

### C1. Order-dependent failures from "it will be on page 1"
Three assertions assumed a seeded row appears in the first page of a list that other
test files append to. One of them failed intermittently during this audit.

| Assertion | Fix |
|---|---|
| `/events` contains seeded `U80` | filter by title |
| `/events` contains public `U81` | filter by title |
| `/events` contains the invited event | filter by its own title |
| verification queue contains the new student | page through with `limit=100` until found |

The suite was then run **three consecutive times** against the accumulated test
database: 148 pass / 0 fail each time.

### C2. Negative visibility assertions that could not fail
`expect(ids).not.toContain(U80)` passes when the event is correctly hidden **and**
when it merely fell off the page. The test was weaker than it looked.

**Fix:** assert hidden events by direct fetch returning `404`, which pagination
cannot mask, and keep the filtered list assertion for discoverability.

### C3. A "missing" UUID that was actually a seeded row
A new not-found test used `00000000-0000-4000-8000-000000000001`, which is the seeded
**CSE department**. The test renamed it and then failed for the wrong reason.

**Fix:** `crypto.randomUUID()` for all not-found cases; the seeded department name
was restored. Seeded ids are deterministic low UUIDs and must never be hand-picked
as "unallocated".

### C4. Browser suite polish
Deliberate 4xx responses (a duplicate department code, an unauthorised report read)
were being logged as browser errors. Added an expected-status mechanism, and stopped
treating Chromium's generic "Failed to load resource" console line as a separate
error — the response hook is the authority. Real page errors still fail the run.

---

## D. Performance

### D1. Every user downloaded every panel
The console shipped as one 628 kB bundle. A faculty member who only verifies students
was downloading the admin console, the resource catalogue and the report viewer.

**Fix, two parts:**
1. Role panels are `React.lazy` chunks behind `Suspense`.
2. Web code imported the `@campusops/shared` **barrel**, which re-exports the Zod
   request schemas. Zod cannot be tree-shaken (schema construction is a side effect),
   so the entire validator layer was in the browser bundle. Added a browser-safe
   `@campusops/shared/ui` entry exporting only constants, labels, permissions, types
   and domain helpers, and moved `defaultEligibilityPolicy` out of the schema module
   so the one runtime import did not drag Zod back in.

**Result:** initial JS **160.10 kB (gzip 52.30)**, panels 3.8–24.1 kB loaded on demand.
Two consecutive builds produce identical sizes.

---

## E. Scope and documentation

### E1. The evaluation scope doc contradicted the agreed scope
`docs/evaluation-scope.md` still listed "Student portal: browse visible events,
register, see status" as Eval 1 **website** work, and argued registrations were a web
feature. That was superseded when the website became management-only.

**Fix:** removed the student portal from the web list, added an explicit "there is no
student web portal" paragraph naming who the site serves, corrected the Eval 1
demo description to staff roles, and reclassified registrations as mobile work.
`README.md` had the same stale claim ("the student-facing portal arrives in Phase 4")
and was corrected too.

---

## F. Verified, not changed

These were checked and found correct, and are recorded so the next audit does not
re-litigate them:

- Access token lives in memory only; refresh is an `httpOnly`, `SameSite=Lax` cookie,
  `Secure` in production. A 401 triggers a single-flight refresh and one replay.
- `setSessionLostHandler` returns the app to the sign-in screen when refresh fails.
- No management panel exposes a password hash; the admin user-detail browser test
  asserts this on the rendered text.
- Club candidate search cannot be used to enumerate the student body: it requires
  club-manage rights, a query of at least two characters, a capped limit, and excludes
  outsiders and non-active accounts. Pinned by eight tests.
- Approvals remain **one decision per item**; nothing in the new UI merges them.
- Departments are Admin-write, everyone-read, and the read shape is exactly
  `{id, code, name}` — asserted, so the picker cannot start leaking staff data.
- No dead handlers remain: an automated scan for declared-but-unreferenced functions
  in every panel returns only the exported components themselves.

## G. Still open (carried forward, not hidden)

- **S3 and Brevo have never been exercised with real credentials.** The code paths
  exist and fail loudly when unconfigured. The user will add the Brevo key and
  manual-test before the debugging phase.
- The rate limiter has no dedicated test.
- No Bruno collection; the OpenAPI document plus the parity tests are the contract.
- Mobile endpoints do not exist yet — see the completeness section of
  [`phase4-report.md`](phase4-report.md).
- The website is deliberately plain. Visual design is the user's to apply.
