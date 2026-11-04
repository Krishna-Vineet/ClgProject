# Phase 4.5 — scope correction and hardening

**Status: complete.** The web portal has no knowingly outstanding work. What
remains in the project is the mobile app, then deployment.

---

## 1. What changed, in your terms

### The advisor role is gone
There is no "Club Faculty Advisor" anywhere — not in the database, the API, the
seed, or the portal. A club now has **members** with one of three roles: lead,
coordinator, or **club faculty**.

- Club **leads** add and remove coordinators.
- **HOD/Dean** of the club's department (and Admin) add and remove faculty.
- The last active lead cannot be demoted or removed; promote someone first.

The clubs screen has a separate "Club faculty" picker that only appears for
HOD/Dean and Admin, and searches faculty accounts only.

### There is no scanning staff
The event's own coordinators and its club faculty sign in with their normal
credentials and scan. The separate scanning account was deleted from the seed,
and a test asserts that every scanner in an event's history is one of its
organisers.

### Access QRs are defined per event, in the portal
Open an event → **Access QRs**. Each row is one scannable thing.

| Counter | Uses per participant | Notes |
|---|---|---|
| Main gate entry | Unlimited | |
| Main gate exit | Unlimited | |
| Lunch counter | 1 | Only while you keep it switched **open** |
| Book issue | 3 | Three in total across the day |
| DJ night | 1 | |

Choosing a purpose pre-fills the right policy, and every field stays editable
while the event is running. You can add a counter mid-event, close one, reopen
it, or raise a limit. You cannot lower a limit below what someone has already
used, and you cannot delete a counter that has any scans — close it instead, so
the record survives.

Participants get one pass per confirmed registration. Their app shows each
counter with turns remaining and mints a rotating code for the one they want.
Your scanner sees **Access granted** or **Access denied** with a plain-language
reason, plus the participant's name and college ID number for the identity
check.

The **Scan log** tab records who scanned what, when, which counter, the outcome,
the reason and which organiser scanned it. Filter by counter or outcome.

### Complaints
Open an event → **Complaints** → **Reporting points & QRs**. Create a point for
any spot, including an ad-hoc one, and press **Download PDF**. You get a
printable A4 poster with the QR, the point name and directions, the event title
and date, and the club name — so a student can see who they are reporting to.

Reports appear under **Issues raised**, only in that event's inbox. You can
assign one, move it through In progress → Resolved → Closed, and leave a note.
The student can follow the trail on their own report but cannot resolve it.

---

## 2. Verification

Full evidence in [`phase4.5-verification.log`](phase4.5-verification.log).

| Gate | Result |
|---|---|
| Lint | 151 files, 0 errors |
| Typecheck | shared / api / web all exit 0 |
| Tests | **224 pass, 0 fail**, 1787 assertions, 18 files |
| Web build | 160.69 kB (gzip 52.45), repeat build byte-identical |
| OpenAPI | 3.1.0, 93 paths, **110 operations** (was 89) |
| Browser e2e | **95 checks pass** (24 new + 32 + 39), 0 console errors |
| Layout at 420px | 0px horizontal overflow |
| DB | 0001–0006 applied to both databases, seed idempotent, `db:check` exit 0 |
| Dependency audit | 6 advisories → 4; both API-facing highs fixed |

Only the corrected code was tested, as instructed: 75 new tests across three new
files. Four existing assertions were updated because the scope change made them
obsolete, and one of those was made **stronger** (HOD/Dean can manage a club in
their own department, and still cannot in another).

---

## 3. What the audit caught

Ten real bugs, several silent. The three that mattered most:

1. **Unlimited entry could never have worked.** The old one-redemption-per-
   checkpoint constraint was still in the database; migration 0006 dropped the
   wrong object name. The second entry scan returned a 500.
2. **Every usage counter read zero.** Drizzle renders an interpolated column
   inside a subquery unqualified, so six counters compared a column against
   itself. No error — the portal would simply have shown "0 scans" at a busy gate.
3. **A production build could ship React's development bundle.** Sourcing
   `.env.local` before `bun run build:web` produced 356 kB instead of 161 kB with
   a successful exit code — exactly what you were about to do before deploying.
   The build now ignores the ambient `NODE_ENV` and is byte-identical either way.

Also fixed: any faculty account could read any event's complaint inbox; a code
shown at the wrong counter was burned; constraint violations became 500s after
the Drizzle upgrade; deleting a counter erased refusal history; complaints could
be assigned to people who cannot open them; and a per-IP rate limit would have
throttled an entire venue as if it were one person.

Full list, security review and deliberate decisions:
[`phase4.5-audit.md`](phase4.5-audit.md).

---

## 4. Before you export and test

1. **Fill in `.env` from `.env.example`.** New keys this round:
   - `COMPLAINT_QR_BASE` — the deep link printed in complaint posters
     (default `campusops://complaint`).
   - `QR_SIGNING_SECRET` — optional; leave unset to derive from
     `JWT_ACCESS_SECRET`.
   - `RATE_LIMIT_SCALE` — **keep at 1 in production.** Raise it only for a local
     test session, or the sign-in limiter will stop you after 20 logins a minute.
2. **Run `bun run db:migrate` then `bun run db:seed`** against your Neon database.
   The seed now includes a live "Demo One-Day Tech Fest" with all five counters,
   two complaint points, issued passes and one demo report, so the new tabs are
   not empty on first sign-in.
3. **Build with `bun run build:web`.** It is now safe regardless of `NODE_ENV`.
4. On Render, keep `.bun-version` (1.4.4) committed and set
   `TRUST_PROXY_HEADERS=true` so rate limits see real client addresses. Keep
   `JOBS_ENABLED=false` on a sleeping host and drive maintenance from cron —
   that job now also prunes spent QR nonces.

---

## 5. Honest limits

- **S3 and Brevo have still not run with real credentials.** That is your manual
  test, as agreed.
- **No phone camera has read a printed poster.** The QR is verified
  module-by-module against the encoder in a test, and the scan API is verified
  end to end over HTTP, but the physical loop closes when the mobile app exists.
- **`bun audit` still shows one high advisory for Zod**, patched only in Zod 4.
  The actual attack surface (array schemas without a length cap) is closed in
  every request schema. The version migration is a scoped follow-up, not
  something to slip into a hardening round.
- **Held back on purpose:** React 19, Vite 8, TypeScript 7, Biome 2, postgres.js
  4. None has an advisory against our usage, and each would invalidate the
  current test evidence right before your own testing.

---

## 6. Next

The mobile app: student client (events, registration, pass wallet with rotating
QRs, complaint scanning) and organiser-scanner client (scan → granted/denied).
Every endpoint it needs for access and complaints already exists and is tested.
