# CampusOps — exactly what ships when

This is the binding scope split for the two evaluations, plus what is deliberately
**not** being built unless the college actually adopts CampusOps for real events.

The rule used throughout: **Eval 1 proves the system works with real people on the
web. Eval 2 makes it work in someone's hand at a real event.** Anything that only
matters at institutional scale is future scope.

---

## The one-line version

| | What it means | What an examiner sees |
|---|---|---|
| **Eval 1** | Complete database, complete web backend, working management website with live multi-role staff users, and the mobile app **UI only** | A coordinator, a faculty member, a HOD/Dean and the Principal all logging into the same live system and moving one event from draft to published to reported |
| **Eval 2** | The mobile app actually working, plus everything that depends on being physically at an event | A student registering on a phone, showing a rotating QR, a volunteer scanning it, identity being checked, attendance landing in the report |
| **Future scope** | Only if the college adopts it for real | Multi-college, payments, certificates, hardware gates, ERP/SSO, analytics |

---

## Evaluation 1 — committed deliverables

### 1. Database schema — complete, not partial

All **46 tables** and **30 enums** exist and are migrated, including tables whose
features arrive in Eval 2. This is intentional: the schema is an Eval 1
deliverable in its own right, and it is what proves the design was thought
through rather than grown ad hoc.

- Identity and access: `users`, `student_profiles`, `staff_profiles`,
  `role_assignments`, `departments`, `refresh_tokens`, `auth_tokens`,
  `rate_limit_buckets`, `idempotency_keys`
- Clubs: `clubs`, `club_memberships`
- Events: `events`, `event_revisions`, `event_invitations`, `event_tags`
- Approvals: `approval_bundles`, `approval_requests`, `approval_actions`,
  `approval_request_resources`
- Resources: `resources`, `resource_units`, `resource_reservations`
- Registration and attendance: `registrations`, `registration_history`,
  `passes`, `qr_nonces`, `checkpoints`, `checkpoint_assignments`,
  `redemptions`, `scan_logs`
- Issues: `complaint_locations`, `complaints`, `complaint_updates`
- Quizzes: `quizzes`, `quiz_questions`, `quiz_options`, `quiz_attempts`,
  `quiz_answers`
- Announcements: `announcements`, `announcement_reads`, `device_tokens`
- Operations: `files`, `audit_logs`, `notification_outbox`, `job_runs`,
  **`event_reports`**

Enforced in the database, not just in application code:

- `EXCLUDE USING gist` prevents two events double-booking the same resource unit
- Partial unique indexes guarantee exactly one ORGANIZE and one INVITE_OUTSIDERS
  request per approval bundle, and one current bundle per event
- `audit_logs` is append-only (UPDATE and DELETE both raise)
- **`event_reports` is append-only** — an issued report can never be rewritten
- Foreign keys, CHECK constraints and half-open time ranges throughout

### 2. Backend — complete for every web flow

**84 operations across 73 paths**, documented in OpenAPI 3.1 generated from the
same Zod schemas the routes validate with, so the document cannot drift.

- Custom CampusOps auth: register, verify email by OTP, login, refresh with
  rotation and reuse detection, logout, password change/reset
- Faculty-only verification of college student accounts; students may register
  and change their password, nothing else (both in the mobile app). Outsider students self-register
  without approval
- Role model: `ADMIN` (Principal), `HOD_DEAN` (one category), `FACULTY`,
  `COORDINATOR`, `SCANNER`, `SUPPORT`
- Event engine: draft → submit → approve → publish → live → complete, with
  revision snapshots and optimistic concurrency
- **Individual approvals, never merged**: coordinator asks any faculty → faculty
  approves or escalates to HOD/Dean → they approve or escalate to Admin
- Resource catalogue, availability search, atomic holds, conflict-free booking,
  automatic hold expiry
- Registrations with eligibility evaluation and both admission styles
- **Post-event report generation** (this round): immutable PDF with the approvals
  trail, faculty involvement, resources consumed and the attendee list
- S3-backed private storage for all media, with references in the database
- Transactional audit trail, notification outbox with retry and backoff,
  advisory-locked maintenance jobs
- Rate limiting, idempotency keys, request IDs, redacted logging

### 3. Website — working, with live users

- Coordinator workspace: create events, pick approvers, request resources,
  submit, publish
- Approvals inbox for faculty, HOD/Dean and Admin, with escalation and full
  per-request history
- Resource availability grid, catalogue and unit management, booking calendar
- **Reports workspace**: generate, preview, version and download the event PDF
- Faculty verification queue for student accounts
- Admin console for roles, departments, clubs and resources
- Club management: members, lead/coordinator roles, advisor assignment
- Event operations: draft editing, eligibility policy, invitations, revisions,
  audit trail, start and complete
- Account self-service: profile, roles, password change, session revocation

**There is no student web portal.** The website serves coordinators, club
coordinators and advisors, faculty, HOD/Dean and Admin only. Students (college and
outside) register, browse, take part, get their entry QR and scan complaint QRs
in the mobile app. The event’s own coordinators and faculty scan in the app with their normal login; there is no separate scanning-staff role. An account with no staff
role and no club membership that signs in on the web is told to use the mobile
app and is shown no management tooling.

### 4. Mobile app — UI only (Eval 1 claim)

> Implementation note (Phase 5): the mobile core and on-the-day QR/scanner flows are already implemented and tested ahead of schedule. The Eval 1 *claim* remains UI-only; live mobile functionality is formally accepted in Eval 2.

Screens, navigation, component library, empty/loading/error states, and the
design language. **No claim of live mobile functionality at Eval 1.** Screens to
be shown: sign in, event feed, event detail, my registrations, digital pass,
scanner (camera frame and result states), announcements, profile.

### Eval 1 acceptance gate

- Lint, typecheck and build clean
- Full automated suite green, including adversarial tests for approval bypass,
  resource double-booking, cross-department access and report immutability
- Real-browser walkthrough green with no console errors
- Fresh database migrates and seeds from zero, repeatably
- A live multi-account demo runs end to end without touching the database by hand

---

## Evaluation 2 — must be done by the second submission

Everything below turns the UI prototype into a working app and completes the
features that only make sense when someone is physically at the event.

### Phase 6 — mobile core

- Mobile auth against the same API, secure token storage, session refresh
- Event feed and detail with real visibility rules (public events open to
  outsiders, plus events they are specifically invited to)
- Registration from the phone, including eligibility feedback
- My registrations and status, waitlist position
- Digital pass screen
- Profile view; password change

### Phase 7 — the on-the-day machinery

- **Rotating QR passes** with short-lived nonces, single-use consumption and
  replay rejection
- **Scanner app**: volunteer assignment to checkpoints, scan → grant/deny with a
  reason, offline-tolerant queue
- **Identity assurance**: the pass shows the holder's photo and details so the
  volunteer confirms the real person is present, not someone attending on their
  behalf. ID-check requirement is per checkpoint
- Checkpoint purposes: gate, hall, meal, library, custom
- **Coordinator-generated complaint QRs per event location**, including ad-hoc
  spots. Issues route only to that event's coordinators
- **Quizzes** for seat allocation, supporting both modes: top-N scorers, and
  first-to-qualify until seats fill
- Announcements and push notifications via device tokens
- Meal/redemption tracking for multi-session events

### Phase 8 — hardening and deployment

- Load testing at realistic event-day concurrency (registration opens, gate
  queue at start time)
- Deploy: web on Vercel, Bun API on Render or a small VPS, Neon Postgres, S3
- Real email through Brevo (the user adds the key), manual verification
- Backup and restore rehearsal
- Security review: rate limits under load, token lifetimes, storage ACLs
- Accessibility and low-end Android performance pass

### What Eval 2 adds to the report

The report engine already exists. Eval 2 makes its attendance section richer:
real QR check-in counts, per-checkpoint breakdown, identity-check outcomes and
complaint summaries, instead of registration-only figures. The report states
which source it used, so it never implies physical presence it cannot prove.

---

## Future scope — only if the college actually adopts it

These are **explicitly out of both evaluations.** They are listed so the design
is not accidentally blocked from supporting them later.

| Area | Why it is future scope |
|---|---|
| Cross-drive interview conflict detection | Needs a placement calendar across companies; rare compared with one-day events |
| Multi-college / multi-tenant | The current model is one institution; tenancy is a schema-wide change |
| Payments and fee collection | Requires a payment gateway, reconciliation and refund policy |
| Certificate generation and public verification | Only meaningful once events are official college records |
| SSO with the college ERP, biometric or face matching | Depends on institutional infrastructure and consent policy |
| RFID/NFC gate hardware | Hardware procurement and integration |
| Offline-first scanner sync with conflict resolution | Needed only at real scale and poor connectivity |
| Institutional analytics and MIS dashboards | Valuable after several terms of real data, not before |
| SMS / WhatsApp delivery | Paid channels; email and push cover the pilot |
| Calendar sync (Google/Outlook) | Convenience, not core operations |
| Native app-store publishing | A distribution decision for the college, not a technical blocker |
| Budget and expense settlement | Finance workflow with its own approvals and audit needs |
| Sponsor and stall management | Only for large fests |
| Multi-language UI | Depends on the student body |
| Resume parsing / company ATS portal | Placement-specific product in its own right |

---

## Judgement calls worth confirming

These follow the stated Eval 1 definition, but they are the places where a
different reading is defensible:

1. **QR scanning is Eval 2, not Eval 1.** It cannot work without a functioning
   mobile app, and Eval 1 includes mobile *UI only*. The QR tables, nonce design
   and check-in data model are all in the Eval 1 schema.
2. **Registrations are mobile, not web.** The earlier reading that put a student
   web portal in Eval 1 is withdrawn: students do everything in the app, so
   registration endpoints and screens belong to the mobile phase. Report
   attendance figures are already computed from the schema and are demonstrated
   with seeded check-in data.
3. **Post-event reports are Eval 1.** They were added this round and work on the
   web today; only their QR-derived figures wait for Eval 2.
4. **Quizzes are Eval 2.** They exist to allocate seats at the event, and both
   allocation modes are already designed and in the schema.
