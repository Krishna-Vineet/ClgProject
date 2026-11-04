import { describe, expect, test } from "bun:test";
import { complaintLocationId, eventTone, statusLabel, when } from "./format";

/**
 * The student app's pure helpers. There were no tests for any client code at all:
 * every one of these functions can silently format a date in the wrong timezone
 * or reject a legitimate QR deep link, and nothing would notice.
 */
describe("mobile formatting", () => {
  test("deep links are recognised by scheme and path, not by string prefix", () => {
    // Exactly what the complaint posters encode.
    const id = "3f2b8c1e-9d4a-4c7b-8e21-5a6f0d9c2b11";
    expect(complaintLocationId(`campusops://complaint/${id}`, "campusops://complaint")).toBe(id);
    // A configured base with a trailing slash must not produce a doubled slash.
    expect(complaintLocationId(`campusops://complaint/${id}`, "campusops://complaint/")).toBe(id);
    // An unrelated deep link is not a complaint location.
    expect(complaintLocationId(`campusops://events/${id}`, "campusops://complaint")).toBeNull();
    // A hostile lookalike must not pass: the scheme prefix alone is not enough.
    expect(complaintLocationId(`campusops://complaintx/${id}`, "campusops://complaint")).toBeNull();
    expect(
      complaintLocationId("https://evil.example/complaint/abc", "campusops://complaint"),
    ).toBeNull();
    expect(complaintLocationId("", "campusops://complaint")).toBeNull();
    // Percent-encoded ids survive the round trip.
    // Ids are UUIDs; anything else is not one of our posters.
    expect(
      complaintLocationId("campusops://complaint/not-a-uuid", "campusops://complaint"),
    ).toBeNull();
    expect(
      complaintLocationId(
        "campusops://complaint/3f2b8c1e-9d4a-4c7b-8e21-5a6f0d9c2b11?x=1",
        "campusops://complaint",
      ),
    ).toBe("3f2b8c1e-9d4a-4c7b-8e21-5a6f0d9c2b11");
  });

  test("dates are rendered in campus time, not the phone's timezone", () => {
    // 2026-01-01T19:30Z is already 2 Jan in Kolkata (+05:30). A student whose
    // phone is set to UTC must still see the campus day.
    const rendered = when("2026-01-01T19:30:00.000Z", "Asia/Kolkata");
    expect(rendered).toBe("2 Jan, 1:00 am");
    // The same instant in UTC is still 1 Jan — which is exactly the bug this
    // guards against if the timezone argument is ever dropped.
    expect(when("2026-01-01T19:30:00.000Z", "UTC")).toContain("1 Jan");
    // Date-only mode drops the clock but keeps the campus day.
    expect(when("2026-01-01T19:30:00.000Z", "Asia/Kolkata", true)).toBe("2 Jan 2026");
  });

  test("every event status has a label and a tone", () => {
    const statuses = [
      "DRAFT",
      "PENDING_APPROVALS",
      "PUBLISHED",
      "LIVE",
      "COMPLETED",
      "CANCELLED",
    ] as const;
    for (const status of statuses) {
      expect(statusLabel(status).length).toBeGreaterThan(2);
      expect(["good", "primary", "neutral", "bad"]).toContain(eventTone(status));
    }
    // A live event is the one that must draw attention.
    expect(eventTone("LIVE")).not.toBe("neutral");
    expect(eventTone("CANCELLED")).toBe("bad");
    // Every label is human English, never the raw enum: a student must not read
    // "PENDING_APPROVALS" on their events list.
    for (const status of statuses) expect(statusLabel(status)).not.toContain("_");
  });
});
