import type { ApprovalStatus, ApprovalType } from "../constants/events";
import type { ApprovalTier, GlobalRole } from "../constants/roles";

/**
 * Individual approvals. Requests are grouped in a bundle for display only;
 * every request keeps its own tier, assignee, status, version and history.
 *
 * Route: assigned FACULTY → SENIOR (HOD/Dean) → ADMIN (final).
 * Escalation is explicit. Small events do not automatically visit every tier.
 */

export const NEXT_TIER: Record<ApprovalTier, ApprovalTier | null> = {
  FACULTY: "SENIOR",
  SENIOR: "ADMIN",
  ADMIN: null,
};

export const TIER_ROLE: Record<ApprovalTier, GlobalRole> = {
  FACULTY: "FACULTY",
  SENIOR: "HOD_DEAN",
  ADMIN: "ADMIN",
};

export const TIER_LABELS: Record<ApprovalTier, string> = {
  FACULTY: "Faculty",
  SENIOR: "HOD/Dean",
  ADMIN: "Admin / Principal",
};

export type ActorRoleScope = {
  role: GlobalRole;
  scopeType: "GLOBAL" | "DEPARTMENT";
  departmentId: string | null;
};

export type ApprovalAuthorityInput = {
  actorId: string;
  actorRoles: ActorRoleScope[];
  currentTier: ApprovalTier;
  assignedApproverId: string | null;
  /** Department of the club that owns the event; used for unassigned senior queue claims. */
  clubDepartmentId: string | null;
};

export function canActOnApproval(input: ApprovalAuthorityInput): boolean {
  const requiredRole = TIER_ROLE[input.currentTier];
  const matching = input.actorRoles.filter((r) => r.role === requiredRole);
  if (matching.length === 0) return false;

  // Faculty tier is always personally assigned: "coordinator asks any faculty".
  if (input.currentTier === "FACULTY") {
    return input.assignedApproverId === input.actorId;
  }
  if (input.assignedApproverId) {
    return input.assignedApproverId === input.actorId;
  }
  // Unassigned senior/admin request sits in a tier queue.
  if (input.currentTier === "ADMIN") return true;
  return matching.some(
    (r) =>
      r.scopeType === "GLOBAL" ||
      (input.clubDepartmentId !== null && r.departmentId === input.clubDepartmentId),
  );
}

export function canEscalateTo(from: ApprovalTier, to: ApprovalTier): boolean {
  return NEXT_TIER[from] === to;
}

export const DECISION_ACTIONS = ["APPROVE", "REJECT", "REQUEST_CHANGES"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const DECISION_RESULT_STATUS: Record<DecisionAction, ApprovalStatus> = {
  APPROVE: "APPROVED",
  REJECT: "REJECTED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
};

/** A decision comment is mandatory when the coordinator must act on the feedback. */
export function decisionRequiresComment(action: DecisionAction): boolean {
  return action !== "APPROVE";
}

export type BundleRequestLike = {
  id: string;
  type: ApprovalType;
  isRequired: boolean;
  status: ApprovalStatus;
};

export type BundleSummary = {
  total: number;
  required: number;
  requiredApproved: number;
  pending: number;
  approved: number;
  rejected: number;
  changesRequested: number;
  cancelled: number;
  /** Required requests still awaiting a decision. */
  blockingRequestIds: string[];
  /** Required requests that were rejected, cancelled or sent back for changes. */
  failedRequestIds: string[];
  readyToPublish: boolean;
};

export function summarizeBundle(requests: BundleRequestLike[]): BundleSummary {
  const summary: BundleSummary = {
    total: requests.length,
    required: 0,
    requiredApproved: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    changesRequested: 0,
    cancelled: 0,
    blockingRequestIds: [],
    failedRequestIds: [],
    readyToPublish: false,
  };
  for (const request of requests) {
    if (request.status === "PENDING") summary.pending += 1;
    if (request.status === "APPROVED") summary.approved += 1;
    if (request.status === "REJECTED") summary.rejected += 1;
    if (request.status === "CHANGES_REQUESTED") summary.changesRequested += 1;
    if (request.status === "CANCELLED") summary.cancelled += 1;
    if (!request.isRequired) continue;
    summary.required += 1;
    if (request.status === "APPROVED") summary.requiredApproved += 1;
    if (request.status === "PENDING") summary.blockingRequestIds.push(request.id);
    if (
      request.status === "REJECTED" ||
      request.status === "CHANGES_REQUESTED" ||
      request.status === "CANCELLED"
    ) {
      summary.failedRequestIds.push(request.id);
    }
  }
  summary.readyToPublish =
    summary.required > 0 &&
    summary.blockingRequestIds.length === 0 &&
    summary.failedRequestIds.length === 0;
  return summary;
}

/** A bundle must always contain exactly one required ORGANIZE permission. */
export function validateBundleComposition(
  requests: Array<{ type: ApprovalType; isRequired: boolean }>,
  audience: "COLLEGE_ONLY" | "OUTSIDERS_ALLOWED" | "INVITED_ONLY",
): string[] {
  const problems: string[] = [];
  const organize = requests.filter((r) => r.type === "ORGANIZE");
  if (organize.length !== 1) {
    problems.push("Exactly one ORGANIZE request is required per submission.");
  } else if (!organize[0]?.isRequired) {
    problems.push("The ORGANIZE request must be marked required.");
  }
  if (audience !== "COLLEGE_ONLY") {
    const outsiders = requests.filter((r) => r.type === "INVITE_OUTSIDERS" && r.isRequired);
    if (outsiders.length === 0) {
      problems.push(
        "Events open to outsiders or invitation-only need a required INVITE_OUTSIDERS request.",
      );
    }
  }
  const duplicates = requests.filter((r) => r.type === "INVITE_OUTSIDERS");
  if (duplicates.length > 1) {
    problems.push("Only one INVITE_OUTSIDERS request is allowed per submission.");
  }
  return problems;
}
