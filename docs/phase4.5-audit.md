# Phase 4.5 — critique audit

Written after the work was finished, against the corrected scope. Bugs found
while building are listed with the fix, because several were silent.

## 1. Bugs found and fixed

### 1.1 Unlimited entry was impossible (silent, severe)
The original schema enforced **one redemption per pass per checkpoint**. The new
model counts total uses, so entry/exit (unlimited) and book issue (three uses)
could never work. Migration 0006 tried to remove it with
`DROP INDEX IF EXISTS redemptions_pass_checkpoint_unique`, but the object in the
database was an inline `UNIQUE` **constraint** named
`redemptions_pass_id_checkpoint_id_key`. The drop was a no-op and the second
entry scan returned HTTP 500.

Fixed by dropping both spellings. Caught by
`access.integration.test.ts → entry grants repeatedly`.

### 1.2 Every usage counter read zero (silent, severe)
Six correlated subqueries were written as
`` sql`(SELECT count(*) FROM ${redemptions} r WHERE r.checkpoint_id = ${checkpoints.id})` ``.
Drizzle renders an interpolated column inside a select field **unqualified**, so
the subquery resolved `"id"` against its own table and compared
`r.checkpoint_id = r.id`. Always false, never an error: the portal would have
shown "0 scans" for a busy gate.

Fixed by qualifying the outer column explicitly (`"checkpoints"."id"`), with a
comment explaining why. All six occurrences were in the new code; the rest of
the API was swept and is clean.

### 1.3 Any faculty account could read any event's complaint inbox
The shared `requireEventOperationalRead` guard admits **any** FACULTY, which is
right for approval visibility but wrong for participant reports and scan logs.
Added `requireEventOrganiserRead`: the event's club coordinators and club
faculty, plus departmental HOD/Dean and Admin. Everyone else gets 404, so the
records are not even discoverable. Applied to all access-log, pass-list,
checkpoint-read, complaint-inbox and complaint-summary routes.

### 1.4 A code shown at the wrong counter was burned
The nonce was consumed before the checkpoint match was checked. A participant
who showed their meal code at the entry gate was then told "already scanned" at
the meal counter. The wrong-checkpoint check now runs **before** the nonce is
written, so the code still works at the right counter.

### 1.5 A production build could silently ship React's development bundle
`vite build` inherited `NODE_ENV=development` from a sourced `.env.local`,
producing 356 kB (gzip 107 kB) instead of 161 kB (gzip 52 kB) — with exit code 0.
The user was about to build on Vercel after filling in `.env`. `vite.config.ts`
now forces `NODE_ENV=production` for `command === "build"` before plugins read
it; output is byte-identical under production, development and unset.

### 1.6 Constraint violations turned into 500s after the Drizzle upgrade
Drizzle 0.45 wraps driver errors more deeply. `isUniqueViolation`,
`isCheckViolation` and `isForeignKeyViolation` read `.code` off the top-level
object and stopped matching, so duplicate names returned 500 instead of 409.
All three now go through `pgCode`, which walks the `.cause` chain (with a
cycle guard). `pgCode` itself also had a latent bug: it returned early on the
presence of a `code` key even when the value was undefined.

### 1.7 Deleting a counter could erase refusal history
Deletion was refused only when *redemptions* existed. A counter with only denied
scans — the evidence of repeated attempts at a gate — could be deleted. Now
refused if either redemptions or scan logs exist.

### 1.8 Complaints could be assigned to someone who cannot open them
The comment claimed the assignee was validated; the code only checked that the
user existed. Now the assignee must be an active organiser of that event's club
or have departmental oversight, or the request is rejected.

### 1.9 Stale references to the deleted advisor role
`ClubsPanel.tsx` still sent `facultyAdvisorId` on create and edit and rendered an
"Advisor" column; `App.tsx` told users to "ask your club's faculty advisor"; a
clubs error message said "Faculty advisor must be…". All removed. The
**reports** renderer keeps a `facultyAdvisor` fallback on purpose: reports are
append-only and snapshots filed before this change contain that field.

### 1.10 Rate limiting would have throttled a whole venue as one person
The new QR-mint endpoint is participant-facing. Keyed by IP it would have capped
an entire campus Wi-Fi at 60 mints/minute. `rateLimit` gained `keyBy: "user"`;
minting is keyed by account. Sign-in and registration stay address-keyed because
there is no account yet.

## 2. Performance issues fixed

- **Pass issuance** did one INSERT per confirmed participant inside a
  transaction — 500 round trips for a 500-seat event. Now one bulk statement.
- **The participant wallet** ran two queries per event. Now two queries total,
  grouped in memory.
- **`qr_nonces` was never pruned.** At one code per participant per minute it is
  the fastest-growing table in the system. Added to `pruneOperationalTables`,
  removing only nonces that expired **over an hour ago** so replay protection
  always outlives the code.

## 3. Security review

| Area | Position |
|---|---|
| QR forgery | HMAC-SHA256 over the payload; key derived from `JWT_ACCESS_SECRET` with a distinct label, or `QR_SIGNING_SECRET`. Compared with `timingSafeEqual`. |
| QR replay | Only `hashNonce(token)` is stored; a unique constraint makes the second scan of a code fail. Verified by a test that scans the same token as two different coordinators. |
| Proxy attendance | `requiresIdCheck` per counter; a MISMATCH or NOT_REQUIRED verdict on an ID-checked counter is denied and consumes no turn. |
| Concurrent last turn | The pass row is locked `FOR UPDATE` before counting, so two gates cannot both grant the last meal. Verified with two simultaneous scans. |
| Who may scan | The event's club coordinators and club faculty, plus Admin. No separate scanning account exists in schema, seed or UI. |
| Who may configure | Club coordinators and Admin. Club faculty can scan and read, not reconfigure. |
| Complaint privacy | Inbox and scan log restricted to the event's organisers plus oversight; 404 for everyone else. |
| Who may report | A CONFIRMED registration for that event, or one of its organisers. A student cannot spam another event's inbox. |
| Data minimisation | `nonceHash` stripped from access-log responses. Pass `publicId` is returned only to its owner. |
| Zod CVE-2023-54404 | The vector is an array schema with no length cap. Every request array now has `.max()`; the three unbounded ones were in the eligibility policy. A 1 MB body limit already applies. The remaining `z.record(z.unknown())` fields cannot accumulate per-element issues because `unknown` never fails. See residual risk below. |
| Drizzle CVE-2026-39356 | Not exploitable here even before the upgrade — the codebase has no `sql.identifier()` or dynamic `.as()`; all identifiers are static schema objects. Upgraded anyway. |

## 4. Deliberate decisions worth confirming

1. **HOD/Dean can read an event's complaint inbox.** The brief says issues route
   to that event's coordinators, and they do: only that club's organisers get it
   in their inbox. Departmental oversight and Admin can also read it, consistent
   with the substantive powers given to HOD/Dean elsewhere. If you want it
   strictly coordinators-only, that is a one-line change to
   `requireEventOrganiserRead`.
2. **Club faculty cannot add or remove members.** Leads manage coordinators;
   HOD/Dean and Admin manage faculty. This follows the locked decision.
3. **No scanner UI on the website.** Scanning belongs to the mobile app, as
   specified. The portal configures and monitors; `POST /access/scan` is ready
   for the mobile client.
4. **Counter purpose is fixed after creation.** Name, window, limit, ID check and
   the open/closed switch are all editable during the event; changing an ENTRY
   into a MEAL after people have scanned would rewrite what those scans meant.

## 5. Residual risks and follow-ups

- **Zod 3 → 4.** The high-severity advisory is only patched in 4.6.6. The
  exposure is closed in our schemas, but the dependency will keep reporting it.
  A Zod 4 migration touches every schema file and `zod-to-json-schema` (Zod 4 has
  native `z.toJSONSchema`), so it is a scoped piece of work, not a patch. Recommended
  before go-live if you want a clean `bun audit`.
- **Major versions held back on purpose:** React 18 → 19, Vite 6 → 8,
  TypeScript 5.9 → 7, Biome 1.9 → 2, postgres.js 3 → 4. None has an open advisory
  against our usage; each is a migration that would invalidate the current test
  evidence right before your own testing.
- **`pdf-lib` 1.17.1** is effectively unmaintained. It works and produces verified
  output. If it ever needs replacing, `@cantoo/pdf-lib` is a drop-in fork.
- **Mobile transitive advisories** (deepmerge, glob, minimatch) come from Expo
  build tooling and should be handled in the mobile phase.
- **Still unexercised with real credentials:** S3, Brevo, and the Render/Vercel/
  Neon deployment itself. No camera has read a printed poster.
- **`RATE_LIMIT_SCALE`** was added so a local test session is not blocked by the
  sign-in limiter. It defaults to 1 and **must stay 1 in production**.

## 6. What is now complete in the web portal

Access counters (create, edit, open/close live, delete if unused), pass issuance
and revocation, the full scan log with filters, complaint reporting points with
downloadable PDF QR posters, the complaint inbox with assignment and a handling
trail, and the club faculty picker — all wired to the API, all covered by
integration tests and a browser walkthrough. No web-portal work is knowingly
left outstanding.
