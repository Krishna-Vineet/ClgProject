import type { ReservationStatus, ResourceStatus } from "../constants/events";
import { type TimeRange, rangesOverlap } from "./time";

/**
 * Resource units are physical assets. "Two projectors" means PROJECTOR-01 and
 * PROJECTOR-02, never an ambiguous quantity. Overlap protection is enforced by a
 * PostgreSQL exclusion constraint; these helpers give fast, explainable errors.
 */

export const ACTIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = ["HELD", "CONFIRMED"];

export function isActiveReservation(status: ReservationStatus): boolean {
  return ACTIVE_RESERVATION_STATUSES.includes(status);
}

export function isBookableUnit(unitStatus: ResourceStatus, parentStatus: ResourceStatus): boolean {
  return unitStatus === "ACTIVE" && parentStatus === "ACTIVE";
}

export type ReservationLike = TimeRange & {
  id: string;
  resourceUnitId: string;
  status: ReservationStatus;
  eventId?: string;
};

/** Conflicts for a proposed booking, ignoring the event's own reservations. */
export function findConflicts(
  proposed: TimeRange & { resourceUnitId: string },
  existing: ReservationLike[],
  ignoreEventId?: string,
): ReservationLike[] {
  return existing.filter(
    (r) =>
      r.resourceUnitId === proposed.resourceUnitId &&
      isActiveReservation(r.status) &&
      r.eventId !== ignoreEventId &&
      rangesOverlap(r, proposed),
  );
}

export type HoldStateInput = {
  status: ReservationStatus;
  holdExpiresAt: string | Date | null;
  now?: Date;
};

export function isHoldExpired(input: HoldStateInput): boolean {
  if (input.status !== "HELD") return false;
  if (!input.holdExpiresAt) return false;
  return new Date(input.holdExpiresAt).getTime() <= (input.now ?? new Date()).getTime();
}

/** Approval confirms a hold; rejection/cancellation/withdrawal releases it. */
export function nextReservationStatus(
  decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "CANCEL" | "EXPIRE",
): ReservationStatus {
  switch (decision) {
    case "APPROVE":
      return "CONFIRMED";
    case "EXPIRE":
      return "EXPIRED";
    default:
      return "RELEASED";
  }
}

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  HELD: "Held",
  CONFIRMED: "Confirmed",
  RELEASED: "Released",
  EXPIRED: "Expired",
};
