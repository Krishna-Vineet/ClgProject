import { describe, expect, test } from "bun:test";
import {
  canActOnApproval,
  canEscalateTo,
  canTransition,
  changedCriticalFields,
  checkPublishable,
  evaluateEligibility,
  findConflicts,
  isHoldExpired,
  mergeRanges,
  nextReservationStatus,
  rangeContains,
  rangesOverlap,
  summarizeBundle,
  validateAdmissionForAudience,
  validateBundleComposition,
  validateEventWindow,
} from "@campusops/shared";

const iso = (h: number, m = 0) =>
  `2026-12-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

describe("time ranges", () => {
  test("adjacent bookings do not overlap (half-open ranges)", () => {
    expect(
      rangesOverlap({ startsAt: iso(9), endsAt: iso(11) }, { startsAt: iso(11), endsAt: iso(13) }),
    ).toBe(false);
    expect(
      rangesOverlap({ startsAt: iso(9), endsAt: iso(11) }, { startsAt: iso(10), endsAt: iso(12) }),
    ).toBe(true);
    expect(
      rangesOverlap({ startsAt: iso(9), endsAt: iso(11) }, { startsAt: iso(9), endsAt: iso(11) }),
    ).toBe(true);
  });

  test("containment respects setup/teardown windows", () => {
    expect(
      rangeContains({ startsAt: iso(9), endsAt: iso(13) }, { startsAt: iso(9), endsAt: iso(13) }),
    ).toBe(true);
    expect(
      rangeContains({ startsAt: iso(9), endsAt: iso(13) }, { startsAt: iso(8), endsAt: iso(13) }),
    ).toBe(false);
  });

  test("merge collapses overlapping and touching blocks", () => {
    const merged = mergeRanges([
      { startsAt: iso(12), endsAt: iso(14) },
      { startsAt: iso(9), endsAt: iso(11) },
      { startsAt: iso(11), endsAt: iso(12) },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.startsAt).toBe(new Date(iso(9)).toISOString());
    expect(merged[0]?.endsAt).toBe(new Date(iso(14)).toISOString());
  });
});

describe("eligibility evaluator", () => {
  const base = {
    version: 1 as const,
    accountTypes: [],
    departmentIds: [],
    graduationYears: [],
    requireInvitation: false,
  };

  test("empty policy allows any account", () => {
    expect(evaluateEligibility(base, { accountType: "OUTSIDER_STUDENT" }).eligible).toBe(true);
  });

  test("account type restriction is enforced", () => {
    const r = evaluateEligibility(
      { ...base, accountTypes: ["COLLEGE_STUDENT"] },
      { accountType: "OUTSIDER_STUDENT" },
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain("ACCOUNT_TYPE_NOT_ALLOWED");
  });

  test("department and batch restrictions accumulate reasons", () => {
    const r = evaluateEligibility(
      { ...base, departmentIds: ["dep-1"], graduationYears: [2027] },
      { accountType: "COLLEGE_STUDENT", departmentId: "dep-2", graduationYear: 2026 },
    );
    expect(r.reasons).toEqual(["DEPARTMENT_NOT_ALLOWED", "GRADUATION_YEAR_NOT_ALLOWED"]);
  });

  test("invitation requirement is separate from audience", () => {
    expect(
      evaluateEligibility({ ...base, requireInvitation: true }, { accountType: "COLLEGE_STUDENT" })
        .reasons,
    ).toContain("INVITATION_REQUIRED");
    expect(
      evaluateEligibility(
        { ...base, requireInvitation: true },
        { accountType: "COLLEGE_STUDENT", hasInvitation: true },
      ).eligible,
    ).toBe(true);
  });
});

describe("approval authority and routing", () => {
  const facultyRoles = [
    { role: "FACULTY" as const, scopeType: "DEPARTMENT" as const, departmentId: "d1" },
  ];

  test("faculty tier requires the named assignee", () => {
    expect(
      canActOnApproval({
        actorId: "f1",
        actorRoles: facultyRoles,
        currentTier: "FACULTY",
        assignedApproverId: "f1",
        clubDepartmentId: "d1",
      }),
    ).toBe(true);
    expect(
      canActOnApproval({
        actorId: "f2",
        actorRoles: facultyRoles,
        currentTier: "FACULTY",
        assignedApproverId: "f1",
        clubDepartmentId: "d1",
      }),
    ).toBe(false);
  });

  test("admin cannot silently decide a faculty-tier request", () => {
    expect(
      canActOnApproval({
        actorId: "a1",
        actorRoles: [{ role: "ADMIN", scopeType: "GLOBAL", departmentId: null }],
        currentTier: "FACULTY",
        assignedApproverId: "f1",
        clubDepartmentId: "d1",
      }),
    ).toBe(false);
  });

  test("unassigned senior queue is department scoped", () => {
    const senior = [
      { role: "HOD_DEAN" as const, scopeType: "DEPARTMENT" as const, departmentId: "d1" },
    ];
    expect(
      canActOnApproval({
        actorId: "h1",
        actorRoles: senior,
        currentTier: "SENIOR",
        assignedApproverId: null,
        clubDepartmentId: "d1",
      }),
    ).toBe(true);
    expect(
      canActOnApproval({
        actorId: "h1",
        actorRoles: senior,
        currentTier: "SENIOR",
        assignedApproverId: null,
        clubDepartmentId: "d2",
      }),
    ).toBe(false);
  });

  test("escalation only moves one tier forward and stops at admin", () => {
    expect(canEscalateTo("FACULTY", "SENIOR")).toBe(true);
    expect(canEscalateTo("FACULTY", "ADMIN")).toBe(false);
    expect(canEscalateTo("SENIOR", "ADMIN")).toBe(true);
    expect(canEscalateTo("ADMIN", "ADMIN")).toBe(false);
  });
});

describe("bundle summary", () => {
  const req = (
    id: string,
    status: "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED" | "CANCELLED",
    isRequired = true,
    type: "ORGANIZE" | "INVITE_OUTSIDERS" | "RESOURCE_USE" | "CUSTOM" = "ORGANIZE",
  ) => ({ id, status, isRequired, type });

  test("optional rejection does not block publishing", () => {
    const s = summarizeBundle([req("1", "APPROVED"), req("2", "REJECTED", false, "CUSTOM")]);
    expect(s.readyToPublish).toBe(true);
    expect(s.failedRequestIds).toEqual([]);
  });

  test("required pending blocks publishing", () => {
    const s = summarizeBundle([req("1", "APPROVED"), req("2", "PENDING")]);
    expect(s.readyToPublish).toBe(false);
    expect(s.blockingRequestIds).toEqual(["2"]);
  });

  test("required rejection is a failure, not just pending", () => {
    const s = summarizeBundle([req("1", "REJECTED")]);
    expect(s.readyToPublish).toBe(false);
    expect(s.failedRequestIds).toEqual(["1"]);
  });

  test("an empty bundle is never publishable", () => {
    expect(summarizeBundle([]).readyToPublish).toBe(false);
  });

  test("composition requires one organize and outsider permission", () => {
    expect(
      validateBundleComposition([{ type: "ORGANIZE", isRequired: true }], "COLLEGE_ONLY"),
    ).toEqual([]);
    expect(
      validateBundleComposition([{ type: "ORGANIZE", isRequired: true }], "OUTSIDERS_ALLOWED")
        .length,
    ).toBeGreaterThan(0);
    expect(
      validateBundleComposition(
        [
          { type: "ORGANIZE", isRequired: true },
          { type: "INVITE_OUTSIDERS", isRequired: true },
        ],
        "OUTSIDERS_ALLOWED",
      ),
    ).toEqual([]);
    expect(
      validateBundleComposition(
        [
          { type: "ORGANIZE", isRequired: true },
          { type: "ORGANIZE", isRequired: true },
        ],
        "COLLEGE_ONLY",
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("admission modes", () => {
  test("quiz-ranked admission is refused until a quiz is attached", () => {
    for (const mode of ["QUIZ_TOP_N", "QUIZ_FIRST_QUALIFIED"] as const) {
      const problems = validateAdmissionForAudience("COLLEGE_ONLY", mode);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain("needs a quiz");
    }
  });

  test("a linked quiz unlocks both quiz seat-allocation modes", () => {
    expect(
      validateAdmissionForAudience("OUTSIDERS_ALLOWED", "QUIZ_TOP_N", { hasLinkedQuiz: true }),
    ).toEqual([]);
    expect(
      validateAdmissionForAudience("COLLEGE_ONLY", "QUIZ_FIRST_QUALIFIED", { hasLinkedQuiz: true }),
    ).toEqual([]);
  });

  test("audience never restricts admission ranking", () => {
    for (const audience of ["COLLEGE_ONLY", "OUTSIDERS_ALLOWED", "INVITED_ONLY"] as const) {
      for (const mode of ["FCFS", "MANUAL"] as const) {
        expect(validateAdmissionForAudience(audience, mode)).toEqual([]);
      }
    }
  });
});

describe("event lifecycle", () => {
  test("legal transitions only", () => {
    expect(canTransition("DRAFT", "PENDING_APPROVALS")).toBe(true);
    expect(canTransition("DRAFT", "PUBLISHED")).toBe(false);
    expect(canTransition("COMPLETED", "DRAFT")).toBe(false);
    expect(canTransition("LIVE", "COMPLETED")).toBe(true);
  });

  test("critical field detection ignores cosmetic edits", () => {
    const before = { title: "Git", description: "old", capacity: 60 };
    expect(changedCriticalFields(before, { description: "new" })).toEqual([]);
    expect(changedCriticalFields(before, { capacity: 80 })).toEqual(["capacity"]);
    expect(changedCriticalFields(before, { title: "Git Advanced" })).toEqual(["title"]);
  });

  test("window validation mirrors DB checks", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    expect(
      validateEventWindow(
        {
          startsAt: iso(9),
          endsAt: iso(11),
          registrationOpensAt: iso(0),
          registrationClosesAt: iso(8),
        },
        now,
      ),
    ).toEqual([]);
    expect(
      validateEventWindow(
        {
          startsAt: iso(9),
          endsAt: iso(8),
          registrationOpensAt: iso(0),
          registrationClosesAt: iso(7),
        },
        now,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateEventWindow(
        {
          startsAt: iso(9),
          endsAt: iso(11),
          registrationOpensAt: iso(0),
          registrationClosesAt: iso(10),
        },
        now,
      ),
    ).toContain("Registration must close at or before the event starts.");
  });

  test("publish gate demands approvals and live holds", () => {
    const base = {
      status: "READY" as const,
      requiredApprovalsReady: true,
      hasRequiredApprovals: true,
      resourceHoldsValid: true,
      registrationClosesAt: iso(8),
      now: new Date("2026-11-30T00:00:00Z"),
    };
    expect(checkPublishable(base).allowed).toBe(true);
    expect(checkPublishable({ ...base, requiredApprovalsReady: false }).code).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(checkPublishable({ ...base, resourceHoldsValid: false }).code).toBe("RESOURCE_CONFLICT");
    expect(checkPublishable({ ...base, status: "DRAFT" }).allowed).toBe(false);
  });
});

describe("resource holds", () => {
  test("conflicts ignore the event's own reservations and released rows", () => {
    const existing = [
      {
        id: "r1",
        resourceUnitId: "u1",
        status: "CONFIRMED" as const,
        eventId: "e1",
        startsAt: iso(9),
        endsAt: iso(11),
      },
      {
        id: "r2",
        resourceUnitId: "u1",
        status: "RELEASED" as const,
        eventId: "e2",
        startsAt: iso(9),
        endsAt: iso(11),
      },
    ];
    expect(
      findConflicts({ resourceUnitId: "u1", startsAt: iso(9), endsAt: iso(11) }, existing, "e1"),
    ).toHaveLength(0);
    expect(
      findConflicts({ resourceUnitId: "u1", startsAt: iso(10), endsAt: iso(12) }, existing),
    ).toHaveLength(1);
  });

  test("only HELD reservations expire", () => {
    const past = "2020-01-01T00:00:00Z";
    expect(isHoldExpired({ status: "HELD", holdExpiresAt: past })).toBe(true);
    expect(isHoldExpired({ status: "CONFIRMED", holdExpiresAt: past })).toBe(false);
    expect(isHoldExpired({ status: "HELD", holdExpiresAt: null })).toBe(false);
  });

  test("decision maps to reservation state", () => {
    expect(nextReservationStatus("APPROVE")).toBe("CONFIRMED");
    expect(nextReservationStatus("REJECT")).toBe("RELEASED");
    expect(nextReservationStatus("CANCEL")).toBe("RELEASED");
    expect(nextReservationStatus("EXPIRE")).toBe("EXPIRED");
  });
});
