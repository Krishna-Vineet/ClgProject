import type { ApprovalTier, GlobalRole } from "../constants/roles";
import { ROLE_TO_APPROVAL_TIER } from "../constants/roles";

export function approvalTierForRole(role: GlobalRole): ApprovalTier | null {
  return ROLE_TO_APPROVAL_TIER[role] ?? null;
}

export function isSeniorRole(role: GlobalRole): boolean {
  return role === "HOD_DEAN";
}

/** Phase 1 only establishes the category. Full scope checks arrive in Phase 2. */
export function canActAtTier(role: GlobalRole, tier: ApprovalTier): boolean {
  return approvalTierForRole(role) === tier;
}
