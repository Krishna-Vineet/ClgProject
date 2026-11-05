# Environment variables: what goes where

## Keep local environments separate

Local development uses one ignored file at the repository root: `.env.local`. Bun loads it for every root command, and the child API, Vite and Expo processes inherit it.

```powershell
Copy-Item .env.example .env.local
```

| Variable | Used by | Put here |
|---|---|---|
| `DATABASE_URL`, `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`, provider and storage settings | API, migrations, tests, bootstrap | Local secrets, never committed |
| `PORT` | API listen port (8787 by default) | The web proxy follows it automatically |
| `API_PORT` | Vite dev proxy | Optional override when the API runs on another port |
| `EXPO_PUBLIC_API_URL` | Expo native/mobile | Absolute API origin; this value is embedded in the app and is public |

If you change the API port, change `PORT`; the Vite proxy uses `API_PORT`, then `PORT`, then tries 8787 and 8087. For a phone, set `EXPO_PUBLIC_API_URL` to `http://<PC-LAN-IPv4>:<API-port>` — never localhost. The API already binds to `0.0.0.0`.

Vite only exposes `VITE_*` variables to the browser, so database URLs, JWT secrets, Brevo keys and S3 keys stay server-side. Production values belong in Render/Vercel/EAS environment settings, not local files.


## Required for every environment

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://… neon.tech/campusops?sslmode=require` | Direct connection. Used by migrations/seed/bootstrap. |
| `AUTO_MIGRATE` | `true` locally, `false` on Render | Apply pending migrations before the API starts. On outside production and off in production: schema changes are a deploy step (`bun run db:migrate`), not a side effect of a process restarting mid-rollout. A failed migration in production now leaves the instance up and degraded (`/health/ready` → 503) instead of crash-looping. |
| `JWT_ACCESS_SECRET` | 64 hex chars | `openssl rand -hex 32`. Signs 15-min access tokens. |
| `REFRESH_TOKEN_PEPPER` | 64 hex chars | Different value. Hashes refresh tokens at rest. |

Runtime prefers `DATABASE_URL_POOLED` when set (Neon pooled endpoint, `-pooler` host); migrations prefer `DATABASE_DIRECT_URL`/`DATABASE_URL`. With Neon transaction pooling the client disables prepared statements automatically.

## API variables (Render / local)

Groups, with defaults from `apps/api/src/config/env.ts`:

- **Runtime**: `NODE_ENV`, `PORT` (8787), `WEB_ORIGIN` (exact website origin, CORS), `APP_BASE_URL` (website URL used in emails), `CAMPUS_TIMEZONE` (Asia/Kolkata), `TRUST_PROXY_HEADERS` (true only behind Render/Vercel which strip client forwarding headers), `TRUSTED_PROXY_HOPS` (how many hops to count from the right edge of `X-Forwarded-For`; 1 for Vercel/Render, 2 behind a load balancer), `MOBILE_SCHEME` (campusops), `COMPLAINT_QR_BASE` (campusops://complaint), `INSTITUTION_NAME`, `REQUEST_TIMEOUT_MS` (20000).
- **Timeouts**: `REQUEST_TIMEOUT_MS` bounds one request end to end and is also sent to Postgres as `statement_timeout`, so a lock wait cannot occupy a pool slot forever. A request that exceeds it returns 504 `REQUEST_TIMEOUT`.
- **Auth**: `ACCESS_TOKEN_TTL_SECONDS` (900), `REFRESH_TOKEN_TTL_DAYS` (30), `OTP_TTL_SECONDS` (600), `OTP_MAX_ATTEMPTS` (5).
- **Demo**: `DEMO_MODE`, `ALLOW_PRODUCTION_DEMO`, `EMAIL_MODE` (demo/brevo/resend), `EXPOSE_DEMO_OTP`, `SEED_DEMO_PASSWORD`. Production refuses demo email unless `ALLOW_PRODUCTION_DEMO=true`; `SEED_DEMO_PASSWORD` is refused in production. Keep all false/unset in production.
- **Email**: `EMAIL_FROM` (verified sender), `BREVO_API_KEY` (you already have it; never share it), or `RESEND_API_KEY`.
- **Storage**: `STORAGE_MODE` (disabled/s3), `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`, `S3_SIGNED_URL_TTL_SECONDS` (300), `UPLOAD_MAX_BYTES` (5 MiB).
- **QR**: `QR_TTL_SECONDS` (60, range 15–300), optional `QR_SIGNING_SECRET` (≥32 chars) to rotate QR keys without ending sessions.
- **Jobs**: `JOBS_ENABLED` (false on Render free), `JOB_INTERVAL_SECONDS`, `NOTIFICATIONS_ENABLED`, `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`, `RESOURCE_HOLD_TTL_HOURS` (72).
- **Caps**: `OUTBOX_FANOUT_MAX`, `INVITATION_LIST_MAX`, `RESOURCE_AVAILABILITY_MAX_UNITS`, `APPROVER_DIRECTORY_MAX`, `REPORT_MAX_ATTENDEES`, `DB_POOL_MAX` (5).
- **Testing only**: `TEST_DATABASE_URL`, `RATE_LIMIT_SCALE` (must stay 1 in production).
- **Bootstrap only**: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_PASSWORD` — read once by `bun run admin:bootstrap`, then remove them.

Invalid combinations fail fast at startup with a message naming the variable (for example `STORAGE_MODE=s3 requires S3_BUCKET`).

## Website variables (Vercel)

The website uses **relative URLs** (`/api/v1/...`). `vercel.json` rewrites `/api/*` and `/health/*` to your Render API, so the browser sees one origin and the httpOnly refresh cookie works. Production needs no client-side API variable; `API_PORT` only configures the local Vite proxy. Do not put secrets in `VITE_*`.

If you instead host the API on a different origin without a rewrite, set `WEB_ORIGIN` on the API to the website origin and be aware that third-party cookie blocking can break refresh; the rewrite approach is the supported one.

## Mobile variables

| Variable | Where | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `.env.local` at build time | Absolute API origin, e.g. `https://campusops-api.onrender.com` (no `/api/v1`). For a phone on local Wi-Fi, use the PC's LAN IPv4 and API port. |
| `MOBILE_SCHEME` | app config | Deep-link scheme (`campusops`). |
| `API_PROXY_TARGET`, `PORT` | `serve-preview.mjs` only | Browser review preview proxy; not part of native builds. |

## Secret hygiene

- Never paste secrets into chat, issues, screenshots or commits.
- Rotate `JWT_ACCESS_SECRET` to invalidate all access tokens; rotate `REFRESH_TOKEN_PEPPER` to invalidate all refresh tokens; rotate `QR_SIGNING_SECRET` to invalidate outstanding QR codes.
- `.gitignore` excludes `.env` and `.env.*`, while allowing the committed `.env.*.example` templates.
