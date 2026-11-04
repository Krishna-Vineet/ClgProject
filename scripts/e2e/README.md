# End-to-end scenario

This directory rebuilds the demo dataset **through the product API**, not with SQL.
It is the script that produced the dataset described in `docs/end-to-end-test.log`
and `docs/autonomous-drone-lab-report.pdf`.

## What it creates

| Step | Coverage |
| --- | --- |
| 1 | Admin signs in; creates 3 departments, 5 programmes, 3 HODs, 10 faculty and 12 student accounts (7 college + 5 outside). |
| 2 | Faculty verify the 7 college students (phone persisted); 3 clubs are created with student leads/coordinators and club faculty. |
| 3 | Admin creates a bookable resource; a coordinator drafts five events covering FCFS, manual, quiz-top-N, first-qualified and outsiders. Quiz papers are attached and every permission is its own approval request. |
| 4 | Faculty, HOD and Admin act on the approval bundles, including a rejection, a change request and a two-tier escalation. Events are published; one is started and both quizzes published. |
| 5 | Participants register; the manual roster is decided; quiz attempts are scored, the TOP_N quiz is closed and seats allocated; FIRST_QUALIFIED seats are assigned on submission. |
| 6 | Access QRs are created and scanned (one-time, toggle, counted, switched off, identity mismatch, replay, offline sync); complaints are raised and handled; announcements posted and revoked. |
| 7 | The event is completed, a report is filed with an integrity checksum, and the PDF is downloaded to `docs/autonomous-drone-lab-report.pdf`. |

## Run it

The API must already be running against the target database, and that database must
be disposable — step 0 drops the `public` schema.

```bash
# terminal 1
bun run dev:api

# terminal 2
scripts/e2e/reset.sh
```

Environment overrides:

- `DATABASE_URL` (default `postgresql://campusops@127.0.0.1:55432/campusops_dev`)
- `SCENARIO_BASE` (default `http://127.0.0.1:8787/api/v1`)
- `SCENARIO_DOCS` (default `<repo>/docs`)

Logs are written next to the steps. `state.json` holds the ids and tokens from the
last run and is ignored by Git.

## Accounts

- Admin: `admin@northfield.edu` / `CampusOps#2026`
- Everyone else: `Northfield#2026`
  - HODs: `hod.cse@northfield.edu`, `hod.ece@northfield.edu`, `hod.mech@northfield.edu`
  - Faculty: `faculty.1..10@northfield.edu`
  - College students: `student.1..7@northfield.edu`
  - Outside students: `outsider.1..5@example.com`

The seeded demo accounts are intentionally **not** used: the schema is dropped and
every account above is created through `/admin/staff`, `/admin/students` or public
registration.
