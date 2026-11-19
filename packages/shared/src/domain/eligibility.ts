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

/**
 * Restriction reason → the plain-language version a student reads.
 *
 * These are keyed by the *restriction*, not by the rejection. A student who is
 * told "restricted to selected graduating batches" and then has nowhere in the
 * product to enter a batch is being blamed for a rule nobody asked them to
 * satisfy, which is what happened on outsider registrations. The student-facing
 * copy now always names what is restricted and who can fix it.
 */
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

/**
 * Can an outsider apply to this event at all?
 *
 * An institution that opens an event to outsiders means it. The student has no
 * department on file and no graduating batch, so applying a departmental rule to
 * them refuses them for a field they were never asked for. Drop the
 * campus-only dimensions for an outsider and keep the ones that make sense for
 * *them* — an invitation, or an explicit account-type list.
 *
 * This is applied before the refusal is shown, so the message a visitor reads is
 * a fact about the event ("by invitation only"), never a request for information
 * the form does not collect.
 */
export function outsiderPolicy(policy: EligibilityPolicy): EligibilityPolicy {
  return {
    ...policy,
    accountTypes: policy.accountTypes.filter((t) => t === "OUTSIDER_STUDENT"),
    departmentIds: [],
    graduationYears: [],
  };
}

/** The policy an application is actually judged against, given who is applying. */
export function policyForSubject(policy: EligibilityPolicy, accountType: AccountType) {
  return accountType === "OUTSIDER_STUDENT" ? outsiderPolicy(policy) : policy;
}
