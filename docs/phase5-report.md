# Phase 5 — coordinator-defined access QRs + mobile app

Status: implemented and verified; awaiting user review/approval.

## 1. Coordinator-defined QR rules (scope correction)

The fixed purpose presets are gone. Migration `0007_coordinator_defined_qrs.sql` replaces them with:

| Field | Coordinator control |
|---|---|
| Name | Free text, 1–80 chars, unique within the event (`abc`, `xyz`, `Main gate`, …) |
| Type | `ONE_TIME`, `TOGGLE` (entry/exit/entry…), `COUNTED` (1–100 uses per participant), `UNLIMITED` |
| Validity | `WINDOW` (start/end instants), `DATE` (one campus-local calendar date), `MANUAL` (only while switched on) |
| Active switch | Pause/resume any QR mid-event without editing its rule |
| ID check | Per-QR college-ID attestation by the scanning organiser |

Safety rules: a counted limit cannot be lowered below uses already recorded; type cannot change after redemption; QRs with history cannot be deleted; names stay unique per event. The decision order is replay → expiry → wrong QR → revoked pass → unconfirmed registration → switched off → event not live → schedule → use limit → identity attestation → grant. A refused scan never consumes a use or flips a toggle.

The web panel (`AccessQrPanel.tsx`) now has QR rules / Passes / Scan log tabs with full-rule editing and a dedicated active-switch endpoint. The participant phone shows the same free-form names as sliding chips, remaining uses, next toggle direction, validity explanation, and a rotating signed QR only when the rule currently allows it.

## 2. Mobile app (Expo / React Native)

Six connected surfaces, no mock data:

- **Auth**: college signup (college ID + real department list), outsider signup, login, forgot/reset password, pending-email OTP entry, faculty-verification pending state.
- **Events**: visible feed (public + invited for outsiders), search, detail with eligibility feedback, FCFS registration, manual-application state, waitlist position, my registrations.
- **Passes**: per-event wallet, QR-name chips, live rules/limits/direction, rotating HMAC-signed nonces (default 60 s), unavailable reasons, revocation notice. Live events sort first.
- **Scan**: organisers inspect a participant (identity + college ID + standing) before attesting ID and recording the scan; students scan complaint-location QRs. Camera path plus paste-code fallback share one parser/contract.
- **Help**: raise an issue against the scanned event location and follow only your own reports.
- **Profile**: read-only verified profile, password change, sign out / sign out everywhere. No student profile editing and no mobile approval UI.

Native refresh tokens use `expo-secure-store`; the browser review preview keeps them in memory only. Access tokens stay in memory. Refresh is single-flight and rotation/reuse detection is unchanged from the backend.

### Versioning (explicitly checked)

Exact pins in `apps/mobile/package.json` / `bun.lock`: Expo **58.0.22**, React **19.3.0**, React Native **0.88.1**, react-native-web **0.21.4**, expo-camera **58.0.14**, expo-secure-store **58.0.2**, expo-linking **58.0.15**, expo-constants **58.0.14**, expo-status-bar **58.0.4**, safe-area-context **5.10.1**, react-native-svg **15.16.0**, qrcode-generator **2.0.4**, TypeScript **5.9.3**, Node **22.23.4** (`.node-version`, engines ≥22.13).

`expo install --check`: up to date. `expo-doctor` 1.17.3: **17/17 checks passed**. Metro bundles exported successfully for **web, Android and iOS** (Hermes bytecode for native). QR rendering uses `qrcode-generator` + `react-native-svg` instead of the Node-only backend `qrcode` package.

## 3. New participant API surface

`GET /auth/departments` (public), `GET /me/registrations`, `GET /events/:id/participant`, `POST /events/:id/register`, `GET /me/complaints`, `POST /access/inspect`. OpenAPI 0.5.0: **100 paths / 117 operations**, parity-tested.

Registration is transactional: row lock, eligibility re-check, FCFS confirm + pass issuance + history in one commit; overflow becomes `WAITLISTED` with queue position; duplicate registration is idempotent; `MANUAL` becomes `APPLIED`; quiz modes return 409 “Evaluation 2”. Staff cannot register. Visibility is enforced before eligibility (hidden events return 404).

## 4. Verification

Raw run: [`docs/phase5-verification.log`](phase5-verification.log).

- API suite: **254 pass / 0 fail**, 1,956 expects, 19 files (includes new registration race/waitlist/eligibility tests, free-form QR rules, non-consuming inspection, complaint-resolution authorization).
- Web e2e: **96 pass / 0 fail** (access/complaints 25, portal 32, management 39), zero console/page errors.
- Mobile browser e2e against the real exported bundle + real API: **12 pass / 0 fail**, zero console/page errors; screenshots `e2e/p5-01…05-*.png`.
- Lint 169 files clean; shared/API/web/mobile typecheck clean; web build deterministic (160.69 kB entry, 52.45 kB gzip, no development React).
- DB: 45 tables, migrations 0001–0007 applied to dev and test; seed idempotent.
- Dependency audit: 3 advisories remain — zod high (mitigated: every array schema has `.max()`; advisory requires unconstrained arrays), glob/minimatch moderate in tooling. No Drizzle advisory exposure (static identifiers only).

## 5. Review preview

```bash
bun run dev:api
bun run build:mobile:web     # static Expo export (low memory)
PORT=8081 bun run preview:mobile
# Native: cd apps/mobile && EXPO_PUBLIC_API_URL=https://your-api npx expo start
```

The preview is labelled “Mobile app · browser review preview”. It is not a student web portal; the management website remains staff-only. Demo credentials are unchanged (`SEED_DEMO_PASSWORD`).

## 6. Not claimed

Physical camera/poster scanning, real Brevo/S3 credentials, deployment, quizzes (Evaluation 2), offline scan queue, registration cancellation. Native bundles were exported and typechecked, not run on a physical device in this sandbox.
