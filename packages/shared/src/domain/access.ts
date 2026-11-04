import {
  type QrDirection,
  type QrType,
  type QrValidityMode,
  qrTypeLimit,
  toggleDirectionForUse,
} from "../constants/operations";

/**
 * Access decisions for event access QRs.
 *
 * A coordinator defines each QR freely: a name, what it does (one time, toggle
 * in/out, a set number of uses, unlimited) and when it is accepted (between two
 * times, on one date, or only while switched on). Nothing here knows about
 * "entry" or "meal" — those are just names a coordinator might type.
 *
 * Pure and dependency-free so the API and the mobile app decide identically and
 * the rules can be tested directly.
 */

export type AccessDenyReason =
  | "QR_SWITCHED_OFF"
  | "OUTSIDE_WINDOW"
  | "NOT_TODAY"
  | "EVENT_NOT_LIVE"
  | "PASS_REVOKED"
  | "NOT_CONFIRMED"
  | "LIMIT_REACHED"
  | "IDENTITY_MISMATCH"
  | "QR_EXPIRED"
  | "QR_REPLAYED"
  | "WRONG_CHECKPOINT";

export const ACCESS_DENY_LABELS: Record<AccessDenyReason, string> = {
  QR_SWITCHED_OFF: "This QR is switched off right now",
  OUTSIDE_WINDOW: "This QR is not valid at this time",
  NOT_TODAY: "This QR is not valid today",
  EVENT_NOT_LIVE: "The event is not running",
  PASS_REVOKED: "This pass has been revoked",
  NOT_CONFIRMED: "This participant is not confirmed for the event",
  LIMIT_REACHED: "This participant has used all their scans",
  IDENTITY_MISMATCH: "Identity did not match the pass",
  QR_EXPIRED: "This code has expired — ask them to refresh it",
  QR_REPLAYED: "This code has already been scanned",
  WRONG_CHECKPOINT: "This code is for a different QR",
};

export type IdentityCheck = "MATCH" | "MISMATCH" | "NOT_REQUIRED";

/**
 * The shape a QR must have for a decision. `validFrom`/`validUntil` are used by
 * WINDOW, `validOn` (YYYY-MM-DD) by DATE; MANUAL uses neither.
 */
export type AccessQr = {
  id: string;
  name: string;
  qrType: QrType;
  maxUses: number | null;
  validityMode: QrValidityMode;
  validFrom: string | Date | null;
  validUntil: string | Date | null;
  validOn: string | null;
  isActive: boolean;
  requiresIdCheck: boolean;
};

export type AccessDecisionInput = {
  qr: AccessQr;
  eventStatus: string;
  passRevoked: boolean;
  registrationStatus: string;
  /** How many times this pass has already used this QR. */
  usedCount: number;
  identityCheck: IdentityCheck;
  /** Campus timezone, used to decide what "today" means for a DATE QR. */
  timeZone?: string;
  scannedForQrId?: string | null;
  qrExpired?: boolean;
  qrReplayed?: boolean;
  now?: Date;
};

export type AccessDecision = {
  result: "GRANTED" | "DENIED";
  reason: AccessDenyReason | "OK";
  message: string;
  /** Which use this grant is, when granted. */
  useNumber: number | null;
  /** Uses left after this grant; null means unlimited. */
  remainingAfter: number | null;
  /** For a TOGGLE QR, which way this scan counted. */
  direction: QrDirection | null;
};

/** The calendar date of an instant, in a given timezone, as YYYY-MM-DD. */
export function calendarDateIn(value: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD; formatToParts avoids locale surprises.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function remaining(limit: number | null, used: number): number | null {
  return limit === null ? null : Math.max(0, limit - used);
}

function denied(reason: AccessDenyReason, input: AccessDecisionInput): AccessDecision {
  const limit = qrTypeLimit(input.qr.qrType, input.qr.maxUses);
  return {
    result: "DENIED",
    reason,
    message: ACCESS_DENY_LABELS[reason],
    useNumber: null,
    remainingAfter: remaining(limit, input.usedCount),
    direction: null,
  };
}

/**
 * Order matters: the most actionable reason for the person at the gate comes
 * first. A QR the coordinator has switched off should say so rather than
 * reporting an identity problem the scanner never got to check.
 */
export function decideAccess(input: AccessDecisionInput): AccessDecision {
  const now = input.now ?? new Date();
  const qr = input.qr;
  const limit = qrTypeLimit(qr.qrType, qr.maxUses);

  if (input.qrReplayed) return denied("QR_REPLAYED", input);
  if (input.qrExpired) return denied("QR_EXPIRED", input);
  if (input.scannedForQrId && input.scannedForQrId !== qr.id)
    return denied("WRONG_CHECKPOINT", input);
  if (input.passRevoked) return denied("PASS_REVOKED", input);
  if (input.registrationStatus !== "CONFIRMED") return denied("NOT_CONFIRMED", input);
  // The switch applies in every validity mode, so a coordinator can always stop
  // a QR immediately without editing its schedule.
  if (!qr.isActive) return denied("QR_SWITCHED_OFF", input);
  if (input.eventStatus !== "LIVE") return denied("EVENT_NOT_LIVE", input);

  if (qr.validityMode === "WINDOW") {
    const from = qr.validFrom ? new Date(qr.validFrom).getTime() : null;
    const until = qr.validUntil ? new Date(qr.validUntil).getTime() : null;
    if (from !== null && now.getTime() < from) return denied("OUTSIDE_WINDOW", input);
    if (until !== null && now.getTime() > until) return denied("OUTSIDE_WINDOW", input);
  } else if (qr.validityMode === "DATE") {
    const today = calendarDateIn(now, input.timeZone ?? "UTC");
    if (qr.validOn !== today) return denied("NOT_TODAY", input);
  }
  // MANUAL: no clock condition at all — the switch above was the whole gate.

  if (limit !== null && input.usedCount >= limit) return denied("LIMIT_REACHED", input);

  if (qr.requiresIdCheck && input.identityCheck !== "MATCH")
    return denied("IDENTITY_MISMATCH", input);

  const useNumber = input.usedCount + 1;
  const direction = qr.qrType === "TOGGLE" ? toggleDirectionForUse(useNumber) : null;
  const counted = limit === null ? "" : ` (use ${useNumber} of ${limit})`;
  const way = direction ? ` — ${direction === "IN" ? "entry" : "exit"} recorded` : "";
  return {
    result: "GRANTED",
    reason: "OK",
    message: `${qr.name}: access granted${counted}${way}`,
    useNumber,
    remainingAfter: remaining(limit, useNumber),
    direction,
  };
}

/** What the participant's app shows for one QR. */
export type QrStanding = {
  qrId: string;
  name: string;
  qrType: QrType;
  maxUses: number | null;
  usedCount: number;
  remaining: number | null;
  isActive: boolean;
  validityMode: QrValidityMode;
  validFrom: string | null;
  validUntil: string | null;
  validOn: string | null;
  /** True when a scan right now would be allowed, ignoring the identity check. */
  availableNow: boolean;
  /** Why it is unavailable, in words, when it is not. */
  unavailableReason: string | null;
  requiresIdCheck: boolean;
  /** For TOGGLE: what the next scan will record. */
  nextDirection: QrDirection | null;
  /** Human summary of the rule, e.g. "One time · only while switched on". */
  summary: string;
};

export function describeQrRule(qr: AccessQr): string {
  const type =
    qr.qrType === "ONE_TIME"
      ? "One time"
      : qr.qrType === "TOGGLE"
        ? "Toggle in / out"
        : qr.qrType === "COUNTED"
          ? `${qr.maxUses ?? 0} use${qr.maxUses === 1 ? "" : "s"}`
          : "Unlimited";
  const when =
    qr.validityMode === "MANUAL"
      ? "only while switched on"
      : qr.validityMode === "DATE"
        ? `on ${qr.validOn ?? "a set date"}`
        : "in its time window";
  return `${type} · ${when}`;
}

export function standingFor(
  qr: AccessQr,
  usedCount: number,
  now = new Date(),
  context: {
    eventStatus?: string;
    passRevoked?: boolean;
    registrationStatus?: string;
    timeZone?: string;
  } = {},
): QrStanding {
  const probe = decideAccess({
    qr,
    eventStatus: context.eventStatus ?? "LIVE",
    passRevoked: context.passRevoked ?? false,
    registrationStatus: context.registrationStatus ?? "CONFIRMED",
    usedCount,
    identityCheck: "MATCH",
    now,
    ...(context.timeZone ? { timeZone: context.timeZone } : {}),
  });
  const limit = qrTypeLimit(qr.qrType, qr.maxUses);
  return {
    qrId: qr.id,
    name: qr.name,
    qrType: qr.qrType,
    maxUses: limit,
    usedCount,
    remaining: remaining(limit, usedCount),
    isActive: qr.isActive,
    validityMode: qr.validityMode,
    validFrom: qr.validFrom ? new Date(qr.validFrom).toISOString() : null,
    validUntil: qr.validUntil ? new Date(qr.validUntil).toISOString() : null,
    validOn: qr.validOn,
    availableNow: probe.result === "GRANTED",
    unavailableReason: probe.result === "GRANTED" ? null : probe.message,
    requiresIdCheck: qr.requiresIdCheck,
    nextDirection: qr.qrType === "TOGGLE" ? toggleDirectionForUse(usedCount + 1) : null,
    summary: describeQrRule(qr),
  };
}
