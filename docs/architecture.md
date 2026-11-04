# Architecture

## Request flow

```
Browser (management web)  ──/api/v1/*──► Vite proxy (dev) / Vercel rewrite (prod) ──► Hono API (Bun) ──► Neon Postgres
Mobile app (native)       ──EXPO_PUBLIC_API_URL/api/v1/*──────────────────────────► Hono API (Bun) ──► Neon Postgres
                                                                                       │
                                                                                       ├──► S3-compatible storage (signed URLs)
                                                                                       └──► Brevo / Resend (transactional email via outbox)
```

- Every response is `{ data, requestId }` or `{ error: { code, message, details }, requestId }`.
- OpenAPI 3.1 is generated from the same Zod schemas the routes validate with (`GET /api/v1/openapi.json`); a parity test fails if a route is undocumented or a documented route is not mounted.
- Body limit 1 MiB; security headers; CORS restricted to `WEB_ORIGIN`; per-route rate limits; idempotency keys on registration/event creation/staff provisioning.

## Auth and sessions

Custom auth (not Neon Auth). Passwords: Argon2id. Access tokens: HS256 JWT, 15 min, kept **in memory** by both clients. Refresh tokens: opaque, hashed with a pepper in DB, 30 days, rotated on every refresh; reuse of a rotated token revokes the whole family.

- **Web**: refresh token in an httpOnly, SameSite=Lax, Secure-in-production cookie scoped to `/api/v1/auth`. JavaScript never sees it. Single-flight refresh prevents concurrent requests from burning multiple tokens.
- **Mobile**: refresh token in `expo-secure-store` (Keychain/Keystore). The browser review preview keeps it in memory only.
- Account statuses: `PENDING_EMAIL` → (college) `PENDING_VERIFICATION` → `ACTIVE`; outsiders go `PENDING_EMAIL` → `ACTIVE`. Suspended/rejected accounts cannot authenticate. Password change revokes every session.

## Roles and scope

Global roles: `ADMIN` (Principal, institution-wide), `HOD_DEAN` (one category, department-scoped), `FACULTY` (department-scoped), `SUPPORT`. Club roles: `LEAD`, `COORDINATOR`, `FACULTY`. There is no scanning-staff role and no "club faculty advisor".

- Only faculty verify college students and edit their profiles; students only register and change password.
- Club leads/coordinators manage events; club faculty read and scan; HOD/Dean manage clubs and club faculty; Admin manages users/roles/departments.
- Approvals: coordinator → any faculty → escalate to HOD/Dean → escalate to Admin. Each permission is a separate request with its own trail; nothing is merged.
- Middleware resolves scope from the database row (event → club → department), never from client-supplied ids. Private records return 404 to outsiders.

## Events, registrations, QRs

Event lifecycle: `DRAFT → PENDING_APPROVALS → READY → PUBLISHED → LIVE → COMPLETED` (or `CANCELLED`). Critical edits create a new revision and require re-approval. Resources are held with a PostgreSQL exclusion constraint so overlapping confirmed/held bookings are impossible.

Registration: transactional row lock, eligibility re-check, FCFS confirm + pass issuance + history in one commit; overflow waitlists with queue position; manual events create applications; quiz modes are refused until Evaluation 2.

Access QRs are coordinator-defined per event: free-form name; type `ONE_TIME | TOGGLE | COUNTED | UNLIMITED`; validity `WINDOW | DATE | MANUAL`; active switch; per-QR ID check. Passes show rotating HMAC-signed tokens (default 60 s, nonce stored hashed, single-use). Scan decision order: replay → expiry → wrong QR → revoked → unconfirmed → off → not live → schedule → limit → identity → grant. Organisers inspect identity before committing a scan; refused scans never consume a use.

Complaints: coordinator-generated QR per event location (including ad-hoc spots), downloadable as a PDF poster with event/club info; only that event's organisers see and act on reports; participants follow their own reports.

## Storage and email

Files (ID proofs, photos, reports, posters) live in private S3-compatible buckets; the DB stores references only. Uploads use short-lived signed PUT URLs with server-side HEAD validation; downloads use signed GET URLs. `STORAGE_MODE=disabled` returns 503 rather than faking success.

Email goes through a transactional outbox written in the same transaction as the action, then dispatched with backoff. `EMAIL_MODE=demo` logs and (only with `EXPOSE_DEMO_OTP`) shows the OTP in the UI; `brevo`/`resend` send real mail and never return the OTP.

## Jobs

`JOBS_ENABLED=true` runs an in-process timer (local). On Render free leave it false and call `POST /api/v1/admin/jobs/maintenance` from a cron, or run `bun run jobs:run` on a schedule. Maintenance expires resource holds, advances event lifecycle, dispatches the outbox and prunes expired tokens/nonces.

## Frontend structure

- `apps/web`: `App.tsx` shell (sidebar, topbar search, notifications, theme, hash routing, error boundary) + lazy-loaded feature panels. `lib/api.ts` is the only fetch wrapper. `lib/session.tsx` exposes role flags. Design tokens in `styles/global.css` (light/dark via `data-theme`).
- `apps/mobile`: `App.tsx` shell with five tabs; `lib/api.ts` mirrors web semantics with SecureStore; screens in `features/`. QR rendering uses `qrcode-generator` + `react-native-svg` (pure JS, no Node built-ins).
- `packages/shared`: enums, Zod schemas, pure domain functions (`decideAccess`, `standingFor`, eligibility, event windows), UI labels. Imported by all three apps.
