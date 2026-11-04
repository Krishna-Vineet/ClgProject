# Troubleshooting

## Setup / install

| Symptom | Cause / fix |
|---|---|
| `bun: command not found` | Open a new shell after install, or add `~/.bun/bin` to PATH. |
| Expo CLI says Node is too old | Mobile needs Node ≥22.13. `nvm use 22.23.4` (see `apps/mobile/.node-version`). The API itself runs on Bun. |
| `Invalid environment: …` at API startup | A variable is missing or inconsistent. The message names the key (e.g. `STORAGE_MODE=s3 requires S3_BUCKET`). Compare with `.env.example`. |
| `http proxy error … ECONNREFUSED` / website 500 | The API process is not listening on the port Vite chose. The Vite terminal prints `[campusops] API proxy → …`; make sure the API is running (`bun run dev:api`) and, if needed, set `API_PORT` in `.env.local` to its port. The proxy now probes `API_PORT`, `PORT`, 8787 and 8087 and returns a readable `502 API_UNAVAILABLE` instead of a bare 500. |
| Env changes ignored | Root commands load the root `.env.local`. Restart `dev:api` and `dev:web` after editing it. |

## Database

| Symptom | Fix |
|---|---|
| `DATABASE_URL … is required` | Set it (local) or add it in Render. Migrations use the direct URL; runtime prefers the pooled one. |
| `relation … does not exist` | Run `bun run db:migrate`. |
| Tests fail on fixture rows | Run the API test setup with `TEST_DATABASE_URL` in `.env.local`; do not point test fixtures at production. |
| Neon "prepared statement already exists" | Use the pooled URL for runtime; the client disables prepared statements for `-pooler` hosts automatically. |
| `password authentication failed` | Role/password mismatch; recreate the local role as in getting-started. |

## Auth / sessions

| Symptom | Fix |
|---|---|
| Login works but reload signs you out (production) | The refresh cookie must be first-party: use the Vercel `/api` rewrite to Render. Check `WEB_ORIGIN` matches the website origin exactly. |
| `RATE_LIMITED` during local tests | Start API with `RATE_LIMIT_SCALE=10` locally; keep 1 in production. |
| Demo OTP not shown | Requires `DEMO_MODE=true`, `EMAIL_MODE=demo`, `EXPOSE_DEMO_OTP=true` together. |
| "Invalid email or password" for demo accounts | `SEED_DEMO_PASSWORD` was not set when `db:seed` ran; re-run the seed with it set. |
| Staff cannot sign up | By design. Admin provisions staff; first Admin via `bun run admin:bootstrap`. |

## Web / mobile

| Symptom | Fix |
|---|---|
| Website is blank after deploy | Check `vercel.json` rewrites point at your Render host; open devtools Network for failing `/api` calls. |
| Mobile native app: "Set EXPO_PUBLIC_API_URL…" | Native builds need the absolute API origin at build time. |
| Phone cannot reach the API | Set `EXPO_PUBLIC_API_URL=http://<PC-LAN-IPv4>:<PORT>` in `.env.local`; keep both devices on the same Wi-Fi and allow that inbound port through Windows Firewall. Test `/health/live` from the phone browser. |
| Metro killed / out of memory | Use the static preview (`build:mobile:web` + `preview:mobile`) or `expo start --max-workers 1`. |
| Camera does not open in browser preview | Browsers require HTTPS or localhost for camera; use the paste-code path for review, real camera on a device. |
| QR shows "switched off" | The coordinator switched that QR off, or its window/date is not active. This is intended. |

## Deployment

| Symptom | Fix |
|---|---|
| Render build fails on lockfile | Commit `bun.lock`; build uses `--frozen-lockfile`. |
| First request after idle is slow | Free Render cold start (~1 min). |
| Emails not arriving | Brevo sender must be verified; check `EMAIL_FROM`, key, and the outbox in Administration → jobs. |
| Upload fails with 503 | `STORAGE_MODE=disabled`; set the S3 group. 403 from S3 → bucket CORS/credentials. |
| Holds never expire / lifecycle stuck | Maintenance cron not running; see deployment.md. |

## Sandbox (Arena review environment)

Installed tooling and the local DB do not survive a workspace reset. Run `bash scripts/restore-sandbox.sh`; if it exits 2, start Postgres with the printed command via the process tool, then re-run. Keep Bun and caches outside `/home/user`. If Chromium crashes with "No space left on device", clear `/tmp/bun-cache` and old Playwright profiles.
