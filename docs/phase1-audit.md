# Phase 1 Critique / Audit

## Verdict

Phase 1 is a valid foundation, but it was not a full implementation of every Phase 0 business rule. That is expected because Phase 1 was scoped to skeleton + database + seed + health. The audit found no decision-level blocker that requires changing the approved product direction.

## Phase 0 decisions checked

| Decision | Phase 1 evidence | Status |
|---|---|---|
| HOD/Dean is one category | `global_role` enum contains `HOD_DEAN`; shared constants/tests use it | Implemented |
| Admin is institutional top role | `ADMIN` global role exists; seed principal | Implemented at schema/seed level |
| Faculty-only college verification | `student_profiles.verified_by` exists; service enforcement scheduled for Phase 2 | Schema ready, enforcement Phase 2 |
| Coordinator is club-scoped | `club_memberships` exists | Schema ready, enforcement Phase 2 |
| Individual approvals grouped by event | `approval_bundles`, `approval_requests`, `approval_actions` | Implemented at schema level |
| Resource units and overlap protection | `resource_units`, `resource_reservations`, exclusion constraint | Implemented and tested |
| Complaint QRs are event-specific locations | `complaint_locations` | Implemented at schema level |
| Access QR/checkpoint model | `checkpoints`, `passes`, `qr_nonces`, `redemptions`, `scan_logs` | Implemented at schema level |
| PostgreSQL only | No MongoDB dependency | Implemented |
| Evaluation 1 mobile is prototype | Mobile shell only | Implemented |

## Issues found and fixed during audit

1. **Auth token storage was missing.** Phase 2 needs email verification, password reset and staff setup tokens. Added `auth_tokens` in migration 0002.
2. **Admin role could be department-scoped.** Added constraint: `ADMIN` must be `GLOBAL`.
3. **Faculty-tier approval requests could lack an assignee.** Added constraint: faculty-tier requests require `assigned_approver_id`.
4. **Password lifecycle metadata was missing.** Added `users.password_updated_at`.
5. **Drizzle schema had minor drift from SQL checks.** Updated Drizzle schema to include the new auth/hardening objects.

## Remaining known limitations

- Real auth, faculty verification, role assignment and club scope enforcement are Phase 2 work.
- Private file upload/signed URLs are not implemented yet; profile proof fields are references only.
- Email delivery uses a development adapter until a provider is configured.
- Neon-specific verification still requires a Neon connection string.

## Decision

No major product-direction issue found. Proceeding to Phase 2.
