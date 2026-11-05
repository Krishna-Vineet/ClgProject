# Review round 2: sixteen complaints, and what the product does now

This is the record of the second review pass. It is written in the same spirit as
`critique-response.md`: name the complaint, name what was actually wrong
underneath it, name what exists instead. Where a complaint was answered by a
decision rather than a patch, the decision is stated with its reasoning.

## The ten web items

| # | Complaint | What was underneath it | What exists now |
|---|---|---|---|
| 1 | A toast raised from a modal was invisible behind the backdrop. | The host was a `position: fixed` div inside `.shell`. `dialog::backdrop` is painted in the browser's **top layer**, which no `z-index` can outrank. | The toast host is a manual popover (`popover="manual"`, re-shown on every new toast) and is pinned top-right with `inset: 16px 20px auto auto`. It now stacks above the dialog *and* above the backdrop. |
| 2 | `POST /departments/programs` returned 504 Gateway Timeout. | A row lock waited on the pool's default statement/connection timeout and the gateway gave up first. | `lock_timeout` (3 s, `DB_LOCK_TIMEOUT_MS`) on every connection; `55P03` maps to `503 DATABASE_BUSY` with `Retry-After: 2` and a message that says nothing was saved. Measured: 3011 ms → 503, previously a 20 s 504. |
| 3 | Adding a faculty member to a club said "No matching faculty found" for a faculty who exists. | The candidate list was filtered to one role, so HOD/Dean and admin accounts were invisible even though the permission check would have accepted them. | `FACULTY_ELIGIBLE_ROLES = [FACULTY, HOD_DEAN, ADMIN]`, deduplicated by user id, filtered to assignments that actually cover approval. `assertIsFacultyAccount` keeps HOD department-bounded — the widening is about who may be *picked*, not about HOD reach. |
| 4 | No way to file a competition. | `event_template` had no value for it; competitions were being filed as `WORKSHOP` or `CUSTOM`, so the list misdescribed them. | `COMPETITION` in the shared constants, the Drizzle enum and migration `0015`. |
| 5 | Creating an event offered only FCFS and Manual. | The draft form hardcoded two `<option>`s while the API accepted four admission modes. | The form renders `ADMISSION_MODES`. Quiz modes still explain that they need an attached quiz. |
| 6 | "Leave blank to send it to the role queue." | A picker offering a nameless destination, which then produced an approval nobody owned. | The option and the hint are gone. A reviewer must be named; the submit guard refuses to send an unnamed request. |
| 7 | "Who may register" was a wall of controls. | Three unrelated inputs stacked in one field. | Chip toggles for account types and departments, a parsed year-range input, and an explicit "requires an invitation" switch. |
| 8 | The tooltip sat in a fixed place and ran off the viewport. | It was anchored to the trigger element's box, not the pointer. | It tracks `clientX/clientY`, flips above/below, and clamps to the viewport. |
| 9 | Approval review expanded a card inline and pushed the list around. | Detail was part of the page flow. | Detail is a `Modal` with the deciding actions in its footer. Failures inside it surface as toasts, because `ErrorNote` is behind the backdrop. |
| 10 | "My tier queue" was a scope switch with no wrong answer. | Three buckets, all of which were requests the viewer could already decide. | Deleted, not defaulted: one flat list, plus a sentence explaining that everything in it is decidable. |

## The six mobile items

1. **Read → close → read again.** Opening an announcement marks it read (it stops
   counting toward the badge) but leaves it in the list. Read state and list
   membership are separate facts, and the API no longer conflates them.
2. **A student sees a Register button, not a quiz.** The quiz surface appears only
   after the registration exists.
3. **Giving up a place is not a cancellation.** Withdrawal removes the
   registration from the roster; the row is revived on re-registration so the
   audit trail survives. Seats permitting, the same student may register again.
4. **Published events stay editable.** Only time, venue and resources force a new
   draft revision; capacity, admission mode, descriptions and template edit in
   place. Guardrails: capacity can never drop below confirmed seats, and a running
   quiz is never orphaned.
5. **Quiz open/close follows the window.** Manual open before `opensAt` is refused;
   manual close is no longer permanent. Between the two times coordinators get
   repeatable pause/resume. A pause blocks *new starts only* — running attempts
   keep their own deadline, and pausing never invalidates a submission. Mobile
   distinguishes *before open*, *paused (contact the coordinators)* and *closed*.
6. **Who to call.** The club's faculty member and lead — name and phone — are on
   the event in the student app, visible to anyone who can see the event.

## Gates at this commit

- `bun run lint` — clean (232 files).
- `bun run typecheck` — shared, API, web, mobile all exit 0.
- `bun run test` — 421 pass, 0 fail, 33 files.
- Migrations `0014_quiz_pause.sql` and `0015_competition_template.sql` applied.
- Browser walkthrough (real Chromium, real API, real database): a failed decision
  inside the approval modal now raises a toast at `top: 16px`, painted above the
  backdrop, with the dialog still open.

## Tests changed with the behaviour, not around it

Three contract tests in `web-contract.test.ts` asserted the *old* UI — that the
panel sends a `scope`, that the form hardcodes two admission modes. They now
assert the new intent: no `scope` is sent, no scope switch exists, and the form
renders the shared list. `phase2.integration.test.ts` stopped borrowing the demo
seed event and creates its own college-only event, because manual probing edited
that row and re-drafted it, failing the suite for reasons that had nothing to do
with authentication.
