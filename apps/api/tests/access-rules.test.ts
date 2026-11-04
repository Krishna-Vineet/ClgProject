import { describe, expect, test } from "bun:test";
import { calendarDateIn, decideAccess, standingFor } from "@campusops/shared";
import { hashNonce, newNonce, signQrPayload, verifyQrToken } from "../src/utils/qr-token";

/**
 * A coordinator defines each QR freely. These tests cover the four types and
 * the three validity modes, not any fixed "entry/meal" taxonomy.
 */

const now = new Date("2026-06-01T10:00:00.000Z");
const TZ = "Asia/Kolkata";

function qr(over: Partial<Parameters<typeof decideAccess>[0]["qr"]> = {}) {
  return {
    id: "qr-1",
    name: "Attendance",
    qrType: "ONE_TIME" as const,
    maxUses: null as number | null,
    validityMode: "MANUAL" as const,
    validFrom: null as string | null,
    validUntil: null as string | null,
    validOn: null as string | null,
    isActive: true,
    requiresIdCheck: true,
    ...over,
  };
}

function decide(over: Partial<Parameters<typeof decideAccess>[0]> = {}) {
  return decideAccess({
    qr: qr(),
    eventStatus: "LIVE",
    passRevoked: false,
    registrationStatus: "CONFIRMED",
    usedCount: 0,
    identityCheck: "MATCH",
    timeZone: TZ,
    now,
    ...over,
  });
}

describe("QR types", () => {
  test("one time grants once and then reports the scans are used", () => {
    const first = decide();
    expect(first.result).toBe("GRANTED");
    expect(first.useNumber).toBe(1);
    expect(first.remainingAfter).toBe(0);
    const second = decide({ usedCount: 1 });
    expect(second.result).toBe("DENIED");
    expect(second.reason).toBe("LIMIT_REACHED");
  });

  test("a counted QR grants exactly the number set, whatever that number is", () => {
    for (const limit of [2, 3, 7]) {
      const target = qr({ name: "Lab access", qrType: "COUNTED", maxUses: limit });
      for (let used = 0; used < limit; used++) {
        const d = decide({ qr: target, usedCount: used });
        expect(d.result).toBe("GRANTED");
        expect(d.useNumber).toBe(used + 1);
        expect(d.remainingAfter).toBe(limit - used - 1);
      }
      expect(decide({ qr: target, usedCount: limit }).reason).toBe("LIMIT_REACHED");
    }
  });

  test("unlimited never runs out", () => {
    const target = qr({ name: "Gate", qrType: "UNLIMITED" });
    const d = decide({ qr: target, usedCount: 500 });
    expect(d.result).toBe("GRANTED");
    expect(d.useNumber).toBe(501);
    expect(d.remainingAfter).toBeNull();
  });

  test("toggle alternates entry and exit from the first scan", () => {
    const target = qr({ name: "Main gate", qrType: "TOGGLE" });
    const expected = ["IN", "OUT", "IN", "OUT", "IN"];
    for (let used = 0; used < expected.length; used++) {
      const d = decide({ qr: target, usedCount: used });
      expect(d.result).toBe("GRANTED");
      expect(d.direction).toBe(expected[used] as "IN" | "OUT");
      expect(d.useNumber).toBe(used + 1);
      expect(d.remainingAfter).toBeNull();
    }
    expect(decide({ qr: target, usedCount: 1 }).message).toContain("exit recorded");
    expect(decide({ qr: target, usedCount: 0 }).message).toContain("entry recorded");
  });

  test("a non-toggle QR records no direction", () => {
    expect(decide().direction).toBeNull();
    expect(decide({ qr: qr({ qrType: "UNLIMITED" }) }).direction).toBeNull();
  });

  test("the name is whatever the coordinator typed and appears in the message", () => {
    for (const name of ["Entry", "Meal", "Attendance", "abc", "xyz", "Lab 3 — viva"]) {
      expect(decide({ qr: qr({ name }) }).message).toContain(name);
    }
  });
});

describe("validity modes", () => {
  test("a window QR is refused before and after its bounds, inclusive at them", () => {
    const target = qr({
      validityMode: "WINDOW",
      validFrom: "2026-06-01T09:00:00.000Z",
      validUntil: "2026-06-01T17:00:00.000Z",
    });
    expect(decide({ qr: target, now: new Date("2026-06-01T08:59:59Z") }).reason).toBe(
      "OUTSIDE_WINDOW",
    );
    expect(decide({ qr: target, now: new Date("2026-06-01T17:00:01Z") }).reason).toBe(
      "OUTSIDE_WINDOW",
    );
    expect(decide({ qr: target, now: new Date("2026-06-01T09:00:00Z") }).result).toBe("GRANTED");
    expect(decide({ qr: target, now: new Date("2026-06-01T17:00:00Z") }).result).toBe("GRANTED");
  });

  test("a date QR covers the whole campus day, not the UTC day", () => {
    // 1 June in Kolkata runs 2026-05-31T18:30Z .. 2026-06-01T18:30Z.
    const target = qr({ validityMode: "DATE", validOn: "2026-06-01" });
    expect(decide({ qr: target, now: new Date("2026-05-31T19:00:00Z") }).result).toBe("GRANTED");
    expect(decide({ qr: target, now: new Date("2026-06-01T18:00:00Z") }).result).toBe("GRANTED");
    // These are 1 June in UTC but already 2 June in Kolkata.
    expect(decide({ qr: target, now: new Date("2026-06-01T19:00:00Z") }).reason).toBe("NOT_TODAY");
    expect(decide({ qr: target, now: new Date("2026-05-31T10:00:00Z") }).reason).toBe("NOT_TODAY");
  });

  test("the campus date helper agrees with the timezone it is given", () => {
    expect(calendarDateIn(new Date("2026-06-01T19:00:00Z"), TZ)).toBe("2026-06-02");
    expect(calendarDateIn(new Date("2026-06-01T19:00:00Z"), "UTC")).toBe("2026-06-01");
  });

  test("a switch-only QR ignores the clock entirely", () => {
    const target = qr({ validityMode: "MANUAL" });
    for (const at of ["2020-01-01T00:00:00Z", "2030-12-31T23:59:59Z"]) {
      expect(decide({ qr: target, now: new Date(at) }).result).toBe("GRANTED");
    }
    expect(decide({ qr: qr({ isActive: false }) }).reason).toBe("QR_SWITCHED_OFF");
  });

  test("the switch can pause a QR even inside its window", () => {
    const target = qr({
      validityMode: "WINDOW",
      validFrom: "2026-06-01T09:00:00.000Z",
      validUntil: "2026-06-01T17:00:00.000Z",
      isActive: false,
    });
    expect(decide({ qr: target }).reason).toBe("QR_SWITCHED_OFF");
  });
});

describe("who may be let through", () => {
  test("a code minted for another QR is refused", () => {
    expect(decide({ scannedForQrId: "other" }).reason).toBe("WRONG_CHECKPOINT");
    expect(decide({ scannedForQrId: "qr-1" }).result).toBe("GRANTED");
  });

  test("someone else cannot attend on a participant's behalf", () => {
    expect(decide({ identityCheck: "MISMATCH" }).reason).toBe("IDENTITY_MISMATCH");
    expect(decide({ identityCheck: "NOT_REQUIRED" }).reason).toBe("IDENTITY_MISMATCH");
    expect(
      decide({ qr: qr({ requiresIdCheck: false }), identityCheck: "NOT_REQUIRED" }).result,
    ).toBe("GRANTED");
  });

  test("a refused identity check consumes no turn on a toggle gate", () => {
    const target = qr({ qrType: "TOGGLE" });
    expect(decide({ qr: target, identityCheck: "MISMATCH" }).direction).toBeNull();
    // The real person still gets the entry, not an exit.
    expect(decide({ qr: target, usedCount: 0 }).direction).toBe("IN");
  });

  test("only a confirmed registration on a running event is granted", () => {
    expect(decide({ registrationStatus: "WAITLISTED" }).reason).toBe("NOT_CONFIRMED");
    expect(decide({ eventStatus: "PUBLISHED" }).reason).toBe("EVENT_NOT_LIVE");
    expect(decide({ eventStatus: "COMPLETED" }).reason).toBe("EVENT_NOT_LIVE");
    expect(decide({ passRevoked: true }).reason).toBe("PASS_REVOKED");
  });

  test("replay is reported ahead of every other reason", () => {
    const d = decide({
      qrReplayed: true,
      qrExpired: true,
      passRevoked: true,
      qr: qr({ isActive: false }),
    });
    expect(d.reason).toBe("QR_REPLAYED");
    expect(decide({ qrExpired: true, passRevoked: true }).reason).toBe("QR_EXPIRED");
  });

  test("every denial reads as a sentence, never a raw enum", () => {
    const cases = [
      { qrReplayed: true },
      { qrExpired: true },
      { scannedForQrId: "x" },
      { passRevoked: true },
      { registrationStatus: "CANCELLED" },
      { qr: qr({ isActive: false }) },
      { eventStatus: "DRAFT" },
      { qr: qr({ validityMode: "DATE", validOn: "2020-01-01" }) },
      { usedCount: 5 },
      { identityCheck: "MISMATCH" as const },
    ];
    for (const c of cases) {
      const d = decide(c);
      expect(d.result).toBe("DENIED");
      expect(d.message.length).toBeGreaterThan(10);
      expect(d.message).not.toBe(d.reason);
    }
  });
});

describe("what the participant phone shows", () => {
  test("remaining never goes negative and unlimited reports null", () => {
    expect(standingFor(qr({ qrType: "COUNTED", maxUses: 3 }), 5, now).remaining).toBe(0);
    expect(standingFor(qr({ qrType: "UNLIMITED" }), 12, now).remaining).toBeNull();
  });

  test("a toggle QR tells the participant what their next scan will do", () => {
    const target = qr({ qrType: "TOGGLE" });
    expect(standingFor(target, 0, now).nextDirection).toBe("IN");
    expect(standingFor(target, 1, now).nextDirection).toBe("OUT");
    expect(standingFor(target, 2, now).nextDirection).toBe("IN");
    expect(standingFor(qr(), 0, now).nextDirection).toBeNull();
  });

  test("the wallet explains why a QR is unavailable", () => {
    const off = standingFor(qr({ isActive: false }), 0, now);
    expect(off.availableNow).toBe(false);
    expect(off.unavailableReason).toContain("switched off");
    const used = standingFor(qr(), 1, now);
    expect(used.availableNow).toBe(false);
    expect(used.unavailableReason).toContain("all their scans");
    expect(standingFor(qr(), 0, now).unavailableReason).toBeNull();
  });

  test("the wallet reflects the event and the pass, not just the QR", () => {
    expect(standingFor(qr(), 0, now, { eventStatus: "PUBLISHED" }).availableNow).toBe(false);
    expect(standingFor(qr(), 0, now, { passRevoked: true }).availableNow).toBe(false);
    expect(standingFor(qr(), 0, now, { registrationStatus: "WAITLISTED" }).availableNow).toBe(
      false,
    );
  });

  test("each QR carries a readable one-line summary of its rule", () => {
    expect(standingFor(qr(), 0, now).summary).toBe("One time · only while switched on");
    expect(standingFor(qr({ qrType: "COUNTED", maxUses: 3 }), 0, now).summary).toContain("3 uses");
    expect(standingFor(qr({ qrType: "TOGGLE" }), 0, now).summary).toContain("Toggle");
    expect(
      standingFor(qr({ validityMode: "DATE", validOn: "2026-06-01" }), 0, now).summary,
    ).toContain("2026-06-01");
  });
});

describe("QR token codec", () => {
  const payload = () => ({
    p: "pass-public-id",
    c: "qr-id",
    e: Date.now() + 60_000,
    n: newNonce(),
  });

  test("a signed payload round-trips", () => {
    const p = payload();
    const out = verifyQrToken(signQrPayload(p));
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.payload).toEqual(p);
    expect(out.nonceHash).toHaveLength(64);
  });

  test("tampering with the payload invalidates the signature", () => {
    const token = signQrPayload(payload());
    const [body, sig] = token.split(".");
    const forged = JSON.parse(Buffer.from(body as string, "base64url").toString());
    forged.p = "someone-elses-pass";
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    expect(verifyQrToken(tampered).ok).toBe(false);
  });

  test("a truncated or nonsense code is rejected, not thrown", () => {
    for (const bad of ["", "abc", "a.b", "!!!!.####", `${"x".repeat(3000)}.${"y".repeat(64)}`]) {
      expect(verifyQrToken(bad).ok).toBe(false);
    }
  });

  test("an expired code is distinguished from a forged one", () => {
    const out = verifyQrToken(signQrPayload({ ...payload(), e: Date.now() - 1000 }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("EXPIRED");
    const forged = verifyQrToken(`${signQrPayload(payload()).split(".")[0]}.AAAA`);
    expect(forged.ok).toBe(false);
    if (forged.ok) throw new Error("unreachable");
    expect(forged.reason).toBe("BAD_SIGNATURE");
  });

  test("each mint produces a distinct nonce, so replays are detectable", () => {
    const a = signQrPayload(payload());
    const b = signQrPayload(payload());
    expect(a).not.toBe(b);
    expect(hashNonce(a)).not.toBe(hashNonce(b));
    expect(hashNonce(a)).not.toContain(a);
    expect(hashNonce(a)).toBe(hashNonce(a));
  });
});
