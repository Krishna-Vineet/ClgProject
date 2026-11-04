# Security notes

## Enforced server-side (never trust the client)

- **Authentication**: Argon2id passwords; short-lived JWT access tokens; rotating refresh tokens hashed with a pepper; reuse detection revokes the family; password change and logout-all revoke sessions. Suspended/rejected accounts are blocked at the middleware.
- **Authorization**: every route checks role and scope resolved from DB rows (event → club → department). Private resources return 404 to non-members so ids are not enumerable. Club faculty cannot manage events or QR rules; only faculty verify students; only HOD/Dean/Admin manage club faculty; Admin guards protect the last admin.
- **Input validation**: Zod on every body/query; array schemas are length-capped; UUID params validated; body limit 1 MiB; strict enums for statuses/types.
- **Concurrency**: resource exclusion constraint in Postgres; registration row locks; optimistic revision checks on events/approvals; idempotency keys for create/register/provision.
- **QR passes**: HMAC-signed short-lived tokens with single-use hashed nonces; wrong-QR/replayed/expired scans are refused without consuming uses; identity attestation required per QR; organisers inspect before commit.
- **Complaints**: only the event's organisers (and departmental oversight) can read/resolve; participants see only their own reports.
- **Files**: private buckets, signed URLs, server-side HEAD validation of size/type, DB references only.
- **Transport/headers**: HTTPS in production, Secure httpOnly SameSite cookie, CORS allowlist, security headers, request ids, audit trail on mutations.
- **Abuse**: per-route rate limits (login, signup, OTP, registration, scan, report generation), OTP attempt caps, mint limits per user.
- **Demo isolation**: demo email/OTP exposure requires explicit flags; production refuses demo email unless explicitly allowed; seed passwords refused in production; bootstrap refuses to add a second Admin.

## Client responsibilities

- Web keeps access tokens in memory and never stores refresh tokens in localStorage. Mobile uses SecureStore. Both use a single-flight refresh.
- Role-gated UI is convenience only; the API re-checks everything.

## Known limits / accepted risks

- Rate limits are stored in Postgres (shared across instances), but the client IP is taken from `X-Forwarded-For` only when `TRUST_PROXY_HEADERS=true`; behind Render/Vercel that header is set by the proxy. If you expose the API directly, keep the flag false so clients cannot spoof their address.
- Dependency advisories: zod (mitigated by capped arrays), glob/minimatch in build tooling. No dynamic SQL identifiers are used, so the Drizzle identifier advisory does not apply.
- No WAF/DDoS protection beyond the host; put Cloudflare in front if exposed publicly at scale.
- Quizzes, offline scan queue and cross-drive interview conflicts are Evaluation 2 / future scope and are refused, not faked.
- Real Brevo/S3 credentials and production deployment are operator responsibilities; the code fails fast when they are missing.

## Reporting a problem

Include the `requestId` from the error response, the role used, and the steps. Never include passwords, tokens or keys.
