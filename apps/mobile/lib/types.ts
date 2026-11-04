import type {
  AccountStatus,
  AccountType,
  AdmissionMode,
  ComplaintCategory,
  ComplaintStatus,
  EventAudience,
  EventStatus,
  EventTemplate,
  QrStanding,
  RegistrationStatus,
} from "@campusops/shared/ui";

export type User = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: AccountStatus;
  accountType: AccountType;
  emailVerifiedAt: string | null;
};
export type StudentProfile = {
  institutionName: string;
  rollNumber: string | null;
  departmentId: string | null;
  program: string | null;
  graduationYear: number | null;
  verificationStatus: string;
  photoFileId: string | null;
  idProofFileId: string | null;
};
export type Me = {
  user: User;
  studentProfile: StudentProfile | null;
  globalRoles: Array<{ role: string; departmentId: string | null }>;
  clubMemberships: Array<{ clubId: string; clubName: string; clubRole: string }>;
};
export type EventRow = {
  id: string;
  clubId: string;
  title: string;
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
  onlineMeetingUrl: string | null;
  jobDescription: string | null;
  cancellationReason: string | null;
};
export type Registration = {
  id: string;
  eventId: string;
  status: RegistrationStatus;
  queuePosition: number | null;
  appliedAt: string;
  confirmedAt: string | null;
  event: EventRow;
  clubName: string;
  passId: string | null;
  passRevokedAt: string | null;
};
export type ParticipantView = {
  event: EventRow;
  club: { id: string; name: string };
  registration: { id: string; status: RegistrationStatus; queuePosition: number | null } | null;
  eligibility: {
    eligible: boolean;
    reasons: string[];
    canApply: boolean;
    registrationOpen: boolean;
  };
  confirmedCount: number;
  seatsRemaining: number | null;
};
export type WalletPass = {
  passId: string;
  publicId: string;
  revokedAt: string | null;
  registrationStatus: RegistrationStatus;
  event: {
    id: string;
    title: string;
    status: EventStatus;
    startsAt: string;
    endsAt: string;
    venueSummary: string | null;
  };
  checkpoints: QrStanding[];
};
export type Nonce = {
  token: string;
  checkpointId: string;
  expiresAt: string;
  refreshAfterSeconds: number;
};
export type ManagedEvent = { id: string; title: string; status: EventStatus; startsAt: string };
export type Checkpoint = {
  id: string;
  name: string;
  qrType: string;
  requiresIdCheck: boolean;
  isActive: boolean;
};
export type ScanInspection = {
  participant: { id: string; fullName: string; email: string };
  checkpoint: { id: string; name: string; requiresIdCheck: boolean };
  standing: QrStanding;
};
export type ScanOutcome = {
  result: "GRANTED" | "DENIED";
  reason: string;
  message: string;
  checkpoint: { id: string; name: string; qrType: string };
  participant: ScanInspection["participant"] | null;
  useNumber: number | null;
  remainingAfter: number | null;
  direction: "IN" | "OUT" | null;
};
export type ComplaintLocation = {
  location: { id: string; label: string; description: string | null };
  event: { id: string; title: string; status: EventStatus };
  club: { id: string; name: string };
};
export type Complaint = {
  id: string;
  eventId: string;
  category: ComplaintCategory;
  description: string;
  status: ComplaintStatus;
  createdAt: string;
  eventTitle: string;
  locationLabel: string;
};
export type ComplaintDetail = {
  complaint: Complaint;
  updates: Array<{
    update: { id: string; toStatus: ComplaintStatus; note: string | null; createdAt: string };
    actor: { fullName: string };
  }>;
};
export type Config = {
  demoMode: boolean;
  emailMode: string | null;
  exposeDemoOtp: boolean;
  storageMode: string;
  campusTimezone: string;
  institutionName: string;
  complaintQrBase: string;
};
export type Challenge = {
  challengeId: string;
  demoOtp?: string;
  delivery: string;
  expiresAt: string;
};
