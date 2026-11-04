import { describe, expect, test } from "bun:test";
import { createResourceSchema, createUnitSchema } from "@campusops/shared";

describe("resource input without legacy category/code fields", () => {
  test("a named resource with multiple named units needs no kind or code", () => {
    const parsed = createResourceSchema.parse({
      name: "Projector",
      unitLabels: ["Projector 01", "Projector 02", "Projector 03"],
    });
    expect(parsed.name).toBe("Projector");
    expect(parsed.unitLabels).toHaveLength(3);
    expect("kind" in parsed).toBe(false);
    expect("code" in parsed).toBe(false);
  });

  test("adding one unit needs only its identifying label", () => {
    const parsed = createUnitSchema.parse({ label: "Auditorium wireless mic 01" });
    expect(parsed.label).toBe("Auditorium wireless mic 01");
    expect("code" in parsed).toBe(false);
  });
});
