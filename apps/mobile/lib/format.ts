import type { ComplaintStatus, EventStatus, RegistrationStatus } from "@campusops/shared/ui";

export function when(value: string, timeZone = "Asia/Kolkata", dateOnly = false) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    ...(dateOnly ? { year: "numeric" } : { hour: "numeric", minute: "2-digit" }),
  }).format(new Date(value));
}
export function eventTone(status: EventStatus): "good" | "primary" | "neutral" | "bad" {
  return status === "LIVE"
    ? "good"
    : status === "PUBLISHED"
      ? "primary"
      : status === "CANCELLED"
        ? "bad"
        : "neutral";
}
export function statusLabel(value: EventStatus | RegistrationStatus | ComplaintStatus) {
  const labels: Record<string, string> = {
    PUBLISHED: "Open for registration",
    LIVE: "Live now",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
    CONFIRMED: "Confirmed",
    WAITLISTED: "Waitlisted",
    APPLIED: "Applied",
    REJECTED: "Not selected",
    IN_PROGRESS: "In progress",
    ASSIGNED: "Assigned",
    OPEN: "Open",
    RESOLVED: "Resolved",
    CLOSED: "Closed",
  };
  return labels[value] ?? value.replace(/_/g, " ").toLowerCase();
}
/** Accept the app scheme or the configured HTTPS complaint base, nothing else. */
export function complaintLocationId(raw: string, configuredBase: string): string | null {
  const value = raw.trim();
  const bases = ["campusops://complaint/", "campusops:///complaint/"];
  if (configuredBase) bases.push(`${configuredBase.replace(/\/$/, "")}/`);
  for (const base of bases) {
    if (value.startsWith(base)) {
      const id = value.slice(base.length).split(/[/?#]/)[0] ?? "";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
    }
  }
  return null;
}
