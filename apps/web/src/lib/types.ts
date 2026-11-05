import type {
  AdmissionMode,
  ApprovalStatus,
  ApprovalTier,
  ApprovalType,
  EventAudience,
  EventStatus,
  EventTemplate,
  ReservationStatus,
} from "@campusops/shared/ui";

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  status: string;
  accountType: string;
};

export type EventRow = {
  id: string;
  clubId: string;
  title: string;
  slug: string;
  description: string;
  template: EventTemplate;
  status: EventStatus;
  audience: EventAudience;
  admissionMode: AdmissionMode;
  capacity: number;
  startsAt: string;
  endsAt: string;
  registrationOpensAt: string;
  registrationClosesAt: string;
  venueSummary: string | null;
  currentRevision: number;
  publishedAt: string | null;
  cancellationReason: string | null;
};

export type ApprovalRequestRow = {
  id: string;
  bundleId: string;
  type: ApprovalType;
  title: string;
  description: string | null;
  isRequired: boolean;
  currentTier: ApprovalTier;
  assignedApproverId: string | null;
  status: ApprovalStatus;
  version: number;
  dueAt: string | null;
  createdAt: string;
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
  blockingRequestIds: string[];
  failedRequestIds: string[];
  readyToPublish: boolean;
};

export type EventBundle = {
  event: EventRow;
  club: { id: string; name: string; departmentId?: string | null };
  bundle: { id: string; createdAt: string } | null;
  requests: Array<{
    request: ApprovalRequestRow;
    assignee: { id: string; fullName: string; email: string } | null;
    resources: Array<{
      link: { startsAt: string; endsAt: string };
      unit: { id: string; label: string };
    }>;
    lastAction: {
      action: {
        id: string;
        action: string;
        comment: string | null;
        createdAt: string;
        fromStatus: ApprovalStatus;
        toStatus: ApprovalStatus;
      };
      actor: { id: string; fullName: string } | null;
    } | null;
  }>;
  summary: BundleSummary;
  history: Array<{
    action: {
      id: string;
      requestId: string;
      action: string;
      comment: string | null;
      createdAt: string;
      fromStatus: ApprovalStatus | null;
      toStatus: ApprovalStatus | null;
      fromTier: ApprovalTier | null;
      toTier: ApprovalTier | null;
    };
    actor: { id: string; fullName: string } | null;
    requestTitle: string;
  }>;
};

export type InboxItem = {
  request: ApprovalRequestRow;
  event: { id: string; title: string; startsAt: string; status: EventStatus };
  club: { id: string; name: string; departmentId: string | null };
  /**
   * What this request is actually about, when it is about a room or a lab:
   * "Computer Lab 2 · Lab 2 Room", or "… +2 more". Null for non-resource asks.
   * The API has always computed it; the inbox simply never showed it, so a
   * reviewer approving a resource request could not see which resource.
   */
  resourceSummary?: string | null;
};

export type RequestDetail = {
  request: ApprovalRequestRow;
  event: EventRow;
  club: { id: string; name: string };
  actions: Array<{
    action: {
      id: string;
      action: string;
      fromTier: ApprovalTier | null;
      toTier: ApprovalTier | null;
      fromStatus: ApprovalStatus | null;
      toStatus: ApprovalStatus | null;
      comment: string | null;
      requestVersion: number;
      createdAt: string;
    };
    actor: { id: string; fullName: string };
  }>;
  resources: Array<{
    link: { startsAt: string; endsAt: string };
    unit: { id: string; label: string; code: string };
    resource: { id: string; name: string; kind: string };
  }>;
  reservations: Array<{ id: string; status: ReservationStatus; holdExpiresAt: string | null }>;
};

export type AvailabilityItem = {
  resourceUnitId: string;
  unitLabel: string;
  unitCode: string;
  unitStatus: string;
  resourceId: string;
  resourceName: string;
  resourceStatus: string;
  departmentId: string | null;
  capacity: number | null;
  available: boolean;
  busyBlocks: Array<{ startsAt: string; endsAt: string }>;
};

export type Approver = {
  id: string;
  fullName: string;
  email: string;
  scopeType: string;
  departmentId: string | null;
};

export type ClubRow = { id: string; name: string; slug: string; departmentId: string | null };

export type AuditItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; fullName: string } | null;
  before: unknown;
  after: unknown;
  createdAt: string;
};
