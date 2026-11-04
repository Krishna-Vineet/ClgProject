# Phase 4 report — the management website

**Status: complete, audited, verified.** Phase 4 built the management console for
coordinators, clubs, faculty, HOD/Dean and Admin, closed the three backend gaps the
website needed, and ran a critic audit whose findings are all fixed.

- Critic audit and every finding: [`phase4-audit.md`](phase4-audit.md)
- Raw verification output: [`phase4-verification.log`](phase4-verification.log)
- Scope of each evaluation: [`evaluation-scope.md`](evaluation-scope.md)

---

## 1. Who the website is for

| Role | What they do on the website |
|---|---|
| **Club coordinator / lead** | Create and edit events, set eligibility, request each permission separately, book resources, invite outsiders, publish, run the day, file the report |
| **Faculty** | Decide approvals, escalate to HOD/Dean, verify college student accounts and correct their profiles, advise clubs |
| **HOD/Dean** | Everything faculty can decide at the senior tier, plus manage departmental resource inventory; reads the student verification queue without deciding on it |
| **Admin (Principal)** | Top authority: final approval tier, provision staff, grant and revoke roles, suspend accounts, departments, clubs, institution-wide resources, maintenance jobs |
| **Club faculty advisor** | Manage the club's members and read its events and reports |

**Students and scanner staff are not web users.** There is no student web portal. An
account with no staff role and no active club membership that signs in on the web is
told to use the mobile app and is shown no management tooling. Registration, event
browsing, participation, entry QR and complaint-QR scanning are all mobile.

## 2. What was built

**Application shell** — session provider with cookie-based silent restore,
single-flight token refresh, role-derived navigation, toast notifications, a native
`<dialog>` confirmation with a real focus trap, and shared loading / empty / forbidden
/ pagination components. Panels are lazy-loaded per role.

**Panels**

| Panel | Contents |
|---|---|
| Events | Filterable, paginated event list; draft creation; per-item approval requests with approver and resource pickers; publish gate |
| Event operations | Day-of start/complete with confirmation; full draft editor including eligibility policy, job description and meeting URL; invitations with expiry and revoke; revision history and audit trail |
| Approvals | Tier-scoped inbox, per-request decision, explicit escalation, reassignment, full history |
| Student verification | Faculty queue, ID proof and photo review, verify / reject with reason, profile correction; read-only for HOD/Dean |
| Resources | Window-based availability search; catalogue and bookable-unit CRUD with status and retire; booking calendar that masks other clubs' events |
| Clubs | List, create (Admin), edit, member management with account search, lead/coordinator promotion, deactivation and removal |
| Reports | Finished-event picker, preview, immutable numbered versions, checksum, PDF download |
| Administration | User directory with search and status filter, user detail with roles and memberships, staff provisioning, role grant/revoke, suspend/reactivate, departments, maintenance and outbox counters |
| Account | Profile, roles, club memberships, password change, sign out, sign out everywhere |
| Sign in | Staff-only sign-in, forgot password, and one code flow that serves both password reset and first-time staff activation |

**Backend added this phase** — three gaps the UI could not work around:

| Endpoint | Why it was needed |
|---|---|
| `GET/POST /departments`, `PATCH /departments/:id` | Every department picker was previously unpopulated. Read is open to any active account, writes are Admin-only, codes are normalised and unique |
| `GET /admin/users/:id` | Revoking a role needs the user's current assignments and memberships; the list endpoint does not carry them |
| `GET /clubs/:id/candidates` | Adding a member needs account search. Guarded by club-manage rights, minimum two-character query, capped limit, and excludes outsiders and non-active accounts |

## 3. Verification

| Gate | Result |
|---|---|
| Lint (Biome) | 136 files, 0 errors |
| Typecheck | shared, api, web — all exit 0 |
| API + integration tests | **148 pass / 0 fail / 837 assertions / 15 files**, three consecutive runs |
| Phase 4 endpoint tests | 23 pass / 0 fail |
| Browser: event lifecycle + reports | **32 passed / 0 failed** |
| Browser: management console | **39 passed / 0 failed** |
| Browser console/page errors | none |
| OpenAPI | 3.1.0, **77 paths / 89 operations**, parity tests pass |
| Schema check | exit 0 |
| Clean-start check | dev database dropped, re-migrated `0001`–`0005`, seeded, both browser suites green |
| Initial JS bundle | **160.10 kB (gzip 52.30)**, down from 628 kB; panels 3.8–24.1 kB on demand |
| Layout at 420px | 0px horizontal overflow |

The browser suites drive real Chromium against the running API: they create clubs,
departments, resources and events, grant and revoke, escalate approvals through two
tiers, publish, file a report and download the PDF, and assert that a bystander
faculty member gets 404 on that report.

## 4. Backend completeness

**Everything the website needs is done. Everything remaining is mobile.**

The API now serves **89 operations across 77 paths**:

| Area | Operations |
|---|---|
| Events (lifecycle, invitations, revisions, eligibility, audit, reports) | 24 |
| Auth and account | 11 |
| Clubs and members | 10 |
| Admin | 9 |
| Resources and units | 8 |
| Faculty verification | 6 |
| Approvals and decisions | 8 |
| Files | 4 |
| Me | 3 |
| Departments | 3 |
| Health and config | 3 |

By table coverage: of **45 tables**, **28** are fully served by web APIs, **4**
(`registrations`, `passes`, `checkpoints`, `redemptions`) are read by the reports
module but have no student or scanner endpoints yet, and **13** have no API code at
all. That is roughly **two-thirds of the planned backend**, and **100% of the
management backend**.

### What remains — all of it mobile

| Domain | Tables exist | Endpoints |
|---|---|---|
| Registration and seat allocation | yes | none |
| Digital pass + rotating QR nonces | yes | none |
| Checkpoints, assignments, scan logs, redemptions | yes | none (read-only for reports) |
| Complaint locations, complaints, updates | yes | none |
| Quizzes, questions, attempts, selection batches | yes | none |
| Announcements | yes | none |
| Push notification devices | yes | none |
| Event chat | yes | none |

The QR design, nonce rotation, identity check and complaint routing are already in
the schema and the blueprint; they need the mobile client to be meaningful, which is
why they were deliberately not built as web endpoints.

## 5. How to review it

```bash
# after a sandbox reset
bash scripts/restore-sandbox.sh          # exits 2 by design; then start PostgreSQL
bun run dev:api                          # :8787
bun run dev:web                          # :5173

bun run lint && bun run typecheck && bun run test
E2E_PASSWORD="$SEED_DEMO_PASSWORD" E2E_CHROMIUM_PATH=/usr/bin/chromium bun run e2e:all
```

Demo accounts (password `CampusOps-Demo-Review-2026!`, demo mode only):

| Account | Role |
|---|---|
| `principal@demo.campusops.local` | Admin (Principal) |
| `hoddean.cse@demo.campusops.local` | HOD/Dean, CSE |
| `faculty.cse@demo.campusops.local` | Faculty, CSE |
| `coding.lead@demo.campusops.local` | Coding Club lead |
| `robotics.coordinator@demo.campusops.local` | Robotics coordinator |
| `student.verified@demo.campusops.local` | College student — **kept out of the console** |
| `outsider@demo.campusops.local` | Outside student — **kept out of the console** |

Email is in demo mode: OTPs and setup codes are shown in the UI and logged, never
sent. Storage is `disabled` locally; reports re-render on demand instead of being
archived. Both are env-switched, not code branches.

## 6. Honest limitations

- **S3 and Brevo have not been run with real credentials.** The paths exist and fail
  loudly when unconfigured. The Brevo key stays with the user, who will manual-test
  before the debugging phase.
- The rate limiter has no dedicated test.
- No Bruno collection; OpenAPI plus parity tests are the contract source.
- The API is a long-lived Bun/Hono server; it cannot run on Vercel serverless. Web
  goes to Vercel, API to Render, Postgres on Neon.
- The UI is intentionally plain and functional. Visual design is deliberately left
  to the user.
- Quiz-based admission modes are refused until a quiz is attached to an event,
  rather than silently behaving like first-come-first-served.

## 7. Next phase

The mobile app: student and scanner clients, and the on-the-day machinery
(registration, rotating entry QR, checkpoint scanning with identity check, complaint
QRs, quizzes, announcements, push). Then hardening and deployment.
