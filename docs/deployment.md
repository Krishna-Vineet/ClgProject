# Deployment: Neon + Render + Vercel + mobile

Target shape (all free tiers are enough for a college pilot):

```
Neon Postgres (DB)  ◄── Render (Bun API) ◄── Vercel (management website, /api rewrite)
                          ▲
                          └── Mobile app (Expo) calls the Render URL directly
Neon S3 / AWS S3 / R2 (private files)      Brevo (email)
```

Deploy in this order. Keep every secret in the hosting dashboards, never in Git.

## 1. Neon Postgres

1. Create a project (region close to your users). Create database `campusops`.
2. Copy the **pooled** connection string (`-pooler` host) and the **direct** string.
3. From your machine, with production env exported:
   ```bash
   export DATABASE_URL='<neon direct>'
   bun run db:migrate
   bun run db:check
   ```
   Do **not** run `db:seed` in production.

## 2. Render — the API

1. Push the repo to GitHub. In Render: **New → Blueprint**, pick the repo; `render.yaml` creates `campusops-api` (Node runtime image with Bun pinned via `BUN_VERSION=1.4.4` — Render has no `runtime: bun` value; build `bun install --frozen-lockfile`, start `bun run apps/api/src/index.ts`, health check `/health/live`). The file is validated against Render's published JSON schema.
2. Fill the secret env vars in the Render dashboard (the blueprint lists them with `sync:false`): `DATABASE_URL`, `DATABASE_URL_POOLED`, `DATABASE_DIRECT_URL`, `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`, `QR_SIGNING_SECRET`, `WEB_ORIGIN` (your Vercel URL), `APP_BASE_URL` (same), `EMAIL_FROM`, `BREVO_API_KEY`, the five `AWS_*`/`S3_BUCKET` values.
3. Production defaults already set by the blueprint: `NODE_ENV=production`, `DEMO_MODE=false`, `EMAIL_MODE=brevo`, `STORAGE_MODE=s3`, `JOBS_ENABLED=false`, `RATE_LIMIT_SCALE=1`, `TRUST_PROXY_HEADERS=true`, `BUN_VERSION=1.4.4`.
4. Deploy. Check `https://<api>.onrender.com/health/ready` → `{"status":"ok"}` with database `ok`.

Free Render instances sleep after 15 min and cold-start in ~1 min; the filesystem is ephemeral (nothing important is stored there — files go to S3). Use Neon, not Render Postgres (free Render DBs expire after 30 days).

### First Admin (Principal)

There is no public staff signup. From a trusted machine:

```bash
DATABASE_URL='<neon direct>' \
BOOTSTRAP_ADMIN_EMAIL=principal@yourcollege.edu \
BOOTSTRAP_ADMIN_NAME='Dr. A. Principal' \
BOOTSTRAP_ADMIN_PASSWORD='<strong temporary password>' \
bun run admin:bootstrap
```

It refuses to run if any ADMIN already exists. Sign in on the website, change the password, then provision HOD/Dean and faculty from **Administration**. Remove the `BOOTSTRAP_ADMIN_*` variables afterwards.

### Maintenance cron

`JOBS_ENABLED=false` on free hosts. Create a cron (Render Cron Job, cron-job.org, or GitHub Actions schedule) that every 2 minutes calls:

```
POST https://<api>.onrender.com/api/v1/admin/jobs/maintenance
Authorization: Bearer <an admin access token>
```

or run `bun run jobs:run` from a machine with the env. This expires holds, advances lifecycle, sends the outbox and prunes tokens.

## 3. Vercel — the management website

1. Import the same repo. Vercel reads `vercel.json`: install `bun install --frozen-lockfile`, build `bun run build:web`, output `apps/web/dist`.
2. Edit `vercel.json` → replace `YOUR-API.onrender.com` with your Render host (both rewrites). Commit. While that placeholder is still there every `/api/*` call is proxied to a host that does not exist, and sign-in fails with a network error rather than a useful message.
3. Deploy. The website calls `/api/*` on its own origin; Vercel forwards to Render, so the httpOnly refresh cookie is first-party and survives browser cookie blocking.
4. Set the API's `WEB_ORIGIN` and `APP_BASE_URL` to the final Vercel URL (and redeploy the API).
5. No Vercel env vars are required. Never add secrets as `VITE_*`.

## 4. Email (Brevo)

You already have the key. In Brevo verify a **single sender** (a verified Gmail address works; no domain needed). Set `EMAIL_FROM="CampusOps <that address>"` and `BREVO_API_KEY` on Render. Send a test by using forgot-password (staff setup codes are requested by the staff member, not shown during provisioning). Free tier: 300 emails/day.

## 5. Storage (S3-compatible)

Create a **private** bucket (Neon S3, AWS S3 or Cloudflare R2). Set `STORAGE_MODE=s3`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (`auto` for R2/Neon), `S3_BUCKET`. Configure CORS on the bucket to allow `PUT, GET, HEAD` from your website origin with headers `Content-Type` (uploads go browser→S3 directly via signed URLs). Test by uploading a student ID proof in the mobile app and generating an event report.

## 6. Mobile app

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=https://<api>.onrender.com npx expo start   # development on a phone
```

For distribution use EAS Build (`eas build --platform android|ios`) with the same `EXPO_PUBLIC_API_URL` set as an EAS environment variable. The scheme `campusops` handles complaint deep links. Native bundles are verified locally with `npx expo export --platform android|ios`.

## 7. Post-deploy checklist

- [ ] `/health/ready` ok; `/api/v1/openapi.json` loads
- [ ] Admin bootstrap done; password changed; demo mode off (`/api/v1/config` shows `demoMode:false`)
- [ ] Staff setup email received (Brevo); OTP not exposed in responses
- [ ] Website sign-in survives a page reload (refresh cookie via rewrite)
- [ ] Student signup → faculty verification → registration → pass → scan on a real phone
- [ ] ID upload and PDF report download work (S3)
- [ ] Complaint poster scans on a phone and routes to the event's organisers
- [ ] Maintenance cron runs (Administration → jobs shows recent runs)
- [ ] `RATE_LIMIT_SCALE=1`, `TRUST_PROXY_HEADERS=true`, no `SEED_DEMO_PASSWORD`

## Updating later

Push to GitHub → Render and Vercel redeploy. Run `bun run db:migrate` against Neon **before** deploying code that needs new columns (migrations are additive and tracked). Mobile updates go through EAS / store review.
