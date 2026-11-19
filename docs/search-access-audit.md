# Search console: what each role can find

Audit in response to: *"Check what each role can search in the search console — an HOD
can't search students even though the Students page shows them."*

The search box in the top bar (`GET /api/v1/search?q=…`) returns three kinds of result:
events, clubs and people. Each was audited separately, because each answers to a
different page.

---

## The rule everything else follows

**Search may return exactly what the role can already open elsewhere.** Anything more
is an enumeration leak; anything less is the bug that was reported, where search says
"no such student" about someone the Students page lists two clicks away.

## What was wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| HOD/Dean could not find students, though the Students page lists them | `people` results only matched the caller's own account and admins; there was no department path at all | `searchablePeople()` now resolves the same `departmentScope()` the Students page uses |
| Faculty could not find students they may verify | same | faculty get students in the departments they are scoped to |
| Two roles could enumerate all users | the fallback branch matched every non-admin too broadly | non-student accounts stay visible to staff (they are colleagues, not personal data); students require department scope |
| Clicking a person always went to Administration | `choose()` hard-coded `navigate("admin")`, which faculty and HOD/Dean cannot open — the click was a dead end | the destination follows the role: Admin → Administration, HOD/Dean → Students, Faculty → Verification |
| Cross-department students appeared for a departmental HOD | scope was not applied to the student subquery at all | students filtered by `departmentId IN (scope)`, parameterised |

## Verified matrix (post-fix)

Searched `q=Student` (a substring of every seeded demo student's name) and individual
names, signed in as each role.

| Role | Events | Clubs | People |
| --- | --- | --- | --- |
| Admin | every event they manage, plus every published event | all | all users |
| HOD / Dean | their departments' events, plus published events | all | **students in their department(s) + all non-student accounts** |
| Faculty | clubs they belong to and their departments' scope, plus published events | all | same as HOD: department-scoped students + staff |
| Club lead / coordinator | their own clubs' events | clubs they belong to | **none** |
| Student | published events they may attend | clubs they belong to | **none** |

Evidence from the live API (demo data, `q=Student`):

- `hoddean.cse@` → 2 students. `faculty.cse@` → the same 2. `principal@` (HQ admin role) → all.
- `faculty.ece@` → 0 students. Correct: the seeded students are CSE.
- `coding.lead@` (club lead) and a plain student → 0 people results, clubs and events only.
- Names of students in other departments returned 0 for a CSE HOD.

## Deliberate decisions

- **Staff accounts are not department-scoped.** A departmental reviewer still has to find
  the faculty they work with, and staff accounts are colleagues rather than personal data
  about students. Only students are narrowed.
- **Club leads and students get no people results at all.** A club lead's job in search is
  their event and their club roster, which lives on the event page; a student has no
  reason to enumerate classmates from a global box. Both can still see the people who
  matter to them where the data belongs (roster, club members).
- **Unverified students stay findable for staff.** Hiding them would make verification
  impossible, and the Students page already lists them for the roles that may act.
- **Events include drafts, but only for people who manage them** (`myManagedEvents`), and
  published events are merged in for everyone who may attend — with a dedupe so a club's
  own event does not appear twice.

## Residual note

Search is a discovery aid, not an authorisation boundary: every destination route
(`/admin/users`, `/faculty/students`, `/faculty/verification-queue`) enforces its own
role check. If search ever over-returns, the click still lands on a 403. The matrix
above is therefore about *usability and minimisation*, not about whether the data was
protected — it was.
