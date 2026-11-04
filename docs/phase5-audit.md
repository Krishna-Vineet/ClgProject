# Phase 5 critique audit

Pass performed after implementation, before delivery. Findings fixed in this round are marked **fixed**; residual items are explicit.

## Scope and prior decisions

- Fixed QR purposes removed from schema, API, web, seed, tests and mobile. No `MEAL/LIBRARY/ENTRY` presets remain.
- Website remains management-only; mobile has no approval UI and no student profile editing.
- College signup requires college ID and department; outsider signup has no faculty-verification fields.
- Quiz admission modes still refuse with Evaluation 2; no silent FCFS fallback.
- Complaint QRs remain per-event, per-location, including ad-hoc spots; only event organisers see/act on them.

## Security / correctness findings

1. **Complaint resolution authorization** — `resolve` originally looked up the report before checking the caller could participate in that event. **Fixed:** `assertMayReport` now runs before resolution; non-participants get 404 and cannot infer report existence. Regression added.
2. **Pending-email dead end on mobile** — resend returned a demo OTP but the pending screen had no code-entry path. **Fixed:** pending screen now sends/resends, shows the demo code only when `exposeDemoOtp`, verifies, and reloads the session.
3. **Wallet ordering** — API orders by `startsAt desc`, so a future event could hide today's live pass. **Fixed:** mobile sorts LIVE first, then upcoming, then history.
4. **Scanner identity assurance** — scan commit requires explicit ID attestation when the QR demands it; inspection is non-consuming and organiser-only. Regression added.
5. **QR rule mutation safety** — counted limit cannot drop below recorded uses; type immutable after redemption; history blocks deletion; active switch is separate and audited. Covered by integration tests.
6. **Registration race** — parallel last-seat requests produce exactly one confirmed registration and one waitlisted; pass issuance is inside the same transaction. Covered.
7. **Visibility before eligibility** — hidden/draft/audience-mismatched events return 404, not an eligibility leak. Covered.
8. **Token handling** — native refresh token in SecureStore; web preview memory-only; single-flight refresh; rotation/reuse detection unchanged. Access token never persisted.
9. **Dependency audit** — zod advisory requires unconstrained arrays; all CampusOps array schemas are capped with `.max()`. glob/minimatch moderate advisories are in build tooling, not request-handling code. Drizzle identifier-injection advisory does not apply (no dynamic `sql.identifier`/`.as` with untrusted input).

## UX findings

- Unavailable QRs explain *why* (switched off / outside window / wrong date / exhausted) instead of showing a dead code.
- Toggle QRs show the next direction; counted QRs show remaining uses; manual QRs show the off state.
- Scanner shows holder name, email, college ID and standing before the destructive commit.
- 390 px viewport has no horizontal overflow; chip rows scroll independently.
- Browser preview is explicitly labelled and is not presented as a student web portal.

## Residual / not claimed

- Physical camera and printed-poster scanning need a device test; paste-code path exercises the same contract.
- Native bundles exported (Android/iOS Hermes) but not installed on hardware here.
- Real Brevo/S3 and deployment remain user-side env steps.
- Offline scan queue, registration cancellation and quizzes are Evaluation 2 / future scope.
- 3 dependency advisories remain as described above; no claim of a zero-advisory tree.
