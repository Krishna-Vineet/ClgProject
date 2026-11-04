# Phase 4 — the management website

## Correction to the scope

The web portal is **staff-only**. Students (college and outside) never use it.
Everything a student or a scanner does lives in the mobile app.

| Surface | Who | What |
|---|---|---|
| **Website** | Coordinators, clubs, faculty, HOD/Dean, Admin | Create events, request and grant permissions, allocate resources, verify student accounts, manage clubs/users/departments, generate reports |
| **Mobile app** | Students, outside students, scanning staff | Register, browse events, take part, entry QR, scan complaint QR, scan attendees |

Approvals stay **web-only**. Faculty/HOD/Dean/Admin do not need them on mobile.
`docs/evaluation-scope.md` is updated to match; the earlier "student web portal"
wording was wrong.

## Backend status

**Management APIs are complete** except one gap found while planning:

- **Missing: departments.** Clubs, staff profiles, resources and role scopes all
  reference `departmentId`, but there is no endpoint to list or create one. The
  admin UI cannot populate a department picker without it. Added in this phase.

**Mobile APIs are not built** and are deliberately out of Phase 4. Tables exist,
routes do not: `registrations`, `passes`, `qr_nonces`, `checkpoints`,
`checkpoint_assignments`, `scan_logs`, `redemptions`, `complaint_locations`,
`complaints`, `complaint_updates`, `quizzes` and related, `announcements`,
`announcement_reads`, `device_tokens`.

## What gets built

Simple, functional UI. No visual polish — that is the user's to add later.

1. **App shell** — role-aware navigation, session bootstrap, automatic access-token
   refresh, global error/toast handling, confirm dialogs for destructive actions.
2. **Events** (coordinator) — existing create/submit/publish, plus draft editing,
   cancel with reason, start/complete, revision history, invitations, audit trail,
   eligibility policy editor.
3. **Approvals** (faculty/HOD/Dean/Admin) — existing inbox and decisions, plus
   reassign, cancel, and resource attachment review.
4. **Resources** — currently read-only. Add resource/unit creation and editing,
   unit retirement, and the booking calendar.
5. **Verification** (faculty) — student queue, profile and ID proof review,
   verify/reject, profile correction.
6. **Clubs** — club list/detail, create/edit, member add/update/remove.
7. **Admin** — user search, staff provisioning, role grant/revoke, suspend/
   reactivate, departments, maintenance jobs.
8. **Account** — profile, roles, memberships, change password, sign out everywhere.

## Security requirements

- Refresh token stays in an httpOnly, SameSite cookie; access token in memory only.
- Automatic single-flight refresh on 401, so concurrent requests do not stampede.
- Destructive actions require confirmation and send a reason where the API takes one.
- Every panel renders loading, empty, error and forbidden states — never a blank screen.
- No role escalation through the UI: the server remains the authority, and the UI
  hides what the caller cannot do rather than relying on that hiding.

## Definition of done

Lint, typecheck and build clean; API tests green; new web contract tests green;
browser walkthrough covering every role and every panel; then a critique audit
with fixes and a final report.
