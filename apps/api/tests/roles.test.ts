import { describe, expect, test } from "bun:test";
import { GLOBAL_ROLES, approvalTierForRole, canActAtTier, isSeniorRole } from "@campusops/shared";

describe("role categories", () => {
  test("HOD/Dean is one category", () => {
    expect(GLOBAL_ROLES).toContain("HOD_DEAN");
    expect(GLOBAL_ROLES).not.toContain("HOD");
    expect(GLOBAL_ROLES).not.toContain("DEAN");
    expect(isSeniorRole("HOD_DEAN")).toBe(true);
  });

  test("approval tier mapping", () => {
    expect(approvalTierForRole("FACULTY")).toBe("FACULTY");
    expect(approvalTierForRole("HOD_DEAN")).toBe("SENIOR");
    expect(approvalTierForRole("ADMIN")).toBe("ADMIN");
    expect(approvalTierForRole("SUPPORT")).toBeNull();
    expect(canActAtTier("HOD_DEAN", "SENIOR")).toBe(true);
    expect(canActAtTier("HOD_DEAN", "ADMIN")).toBe(false);
  });
});
