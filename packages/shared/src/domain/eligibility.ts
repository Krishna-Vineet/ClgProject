import type { AccountType } from "../constants/roles";
import type { EligibilityPolicy } from "../schemas/eligibility";

/**
 * Eligibility answers "who may apply". It never allocates seats — that is admission.
 * The policy is a fixed, server-evaluated structure; no expressions or user code.
 */

export type EligibilitySubject = {
  accountType: AccountType;
  departmentId?: string | null;
  graduationYear?: number | null;
  hasInvitation?: boolean;
};

export type EligibilityReason =
  | "ACCOUNT_TYPE_NOT_ALLOWED"
  | "DEPARTMENT_NOT_ALLOWED"
  | "GRADUATION_YEAR_NOT_ALLOWED"
  | "INVITATION_REQUIRED";

export type EligibilityResult = {
  eligible: boolean;
  reasons: EligibilityReason[];
};

export function evaluateEligibility(
  policy: EligibilityPolicy,
  subject: EligibilitySubject,
): EligibilityResult {
  const reasons: EligibilityReason[] = [];

  if (policy.accountTypes.length > 0 && !policy.accountTypes.includes(subject.accountType)) {
    reasons.push("ACCOUNT_TYPE_NOT_ALLOWED");
  }
  if (policy.departmentIds.length > 0) {
    if (!subject.departmentId || !policy.departmentIds.includes(subject.departmentId)) {
      reasons.push("DEPARTMENT_NOT_ALLOWED");
    }
  }
  if (policy.graduationYears.length > 0) {
    if (!subject.graduationYear || !policy.graduationYears.includes(subject.graduationYear)) {
      reasons.push("GRADUATION_YEAR_NOT_ALLOWED");
    }
  }
  if (policy.requireInvitation && !subject.hasInvitation) {
    reasons.push("INVITATION_REQUIRED");
  }

  return { eligible: reasons.length === 0, reasons };
}

export const ELIGIBILITY_REASON_LABELS: Record<EligibilityReason, string> = {
  ACCOUNT_TYPE_NOT_ALLOWED: "This event is not open to your account type.",
  DEPARTMENT_NOT_ALLOWED: "This event is restricted to selected departments.",
  GRADUATION_YEAR_NOT_ALLOWED: "This event is restricted to selected graduating batches.",
  INVITATION_REQUIRED: "You need an invitation to apply for this event.",
};
