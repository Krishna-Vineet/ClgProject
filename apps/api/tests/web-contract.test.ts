import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as shared from "@campusops/shared";

/**
 * The browser client hand-writes its request payloads. This test parses the
 * payloads the React panels actually send and validates them against the same
 * Zod schemas the API enforces, so a renamed field fails here instead of in a
 * demo. It caught `decision` vs `action` and a missing `toTier` on escalation.
 */
const WEB_SRC = join(import.meta.dir, "../../web/src");

async function source(relative: string) {
  return readFile(join(WEB_SRC, relative), "utf8");
}

describe("web request payloads match the API schemas", () => {
  test("approval decisions use the decisionSchema field names", async () => {
    const src = await source("features/ApprovalsPanel.tsx");
    // Every decision payload must set `action`, never `decision`.
    expect(src).not.toMatch(/\{\s*decision:/);
    const actions = [...src.matchAll(/action:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThanOrEqual(3);
    for (const action of actions) {
      const parsed = shared.decisionSchema.safeParse({
        action,
        comment: "A sufficiently long review comment.",
        expectedVersion: 1,
      });
      expect(parsed.success).toBe(true);
    }
    expect(new Set(actions)).toEqual(new Set(["APPROVE", "REJECT", "REQUEST_CHANGES"]));
  });

  test("escalation always names the next tier explicitly", async () => {
    const src = await source("features/ApprovalsPanel.tsx");
    expect(src).toContain("toTier:");
    for (const toTier of ["SENIOR", "ADMIN"]) {
      const parsed = shared.escalateSchema.safeParse({
        toTier,
        comment: "Escalating for departmental sign-off.",
        expectedVersion: 1,
      });
      expect(parsed.success).toBe(true);
    }
  });

  test("reassignment uses assigneeId and a reason", async () => {
    const src = await source("features/ApprovalsPanel.tsx");
    expect(src).toContain("assigneeId:");
    expect(src).not.toContain("assignedApproverId: reassignTo");
    const parsed = shared.reassignSchema.safeParse({
      assigneeId: "00000000-0000-4000-8000-000000000012",
      reason: "Asking a different faculty member to review.",
      expectedVersion: 1,
    });
    expect(parsed.success).toBe(true);
  });

  test("the inbox asks for no scope: one flat list of decidable requests", async () => {
    const src = await source("features/ApprovalsPanel.tsx");
    // Deliberate product decision: the three-way switch ("Assigned to me" / "My tier
    // queue" / "Everything") is gone. Every row in the inbox is already something the
    // viewer may act on, so the panel must not send a scope at all, and must not
    // reintroduce the switch or its "tier queue" copy.
    expect(src).not.toMatch(/scope\s*:/);
    expect(src).not.toContain("My tier queue");
    expect(src).not.toContain('role="tablist"');
    // Not sending a scope has to stay valid: the API default is the flat list.
    expect(shared.approvalInboxQuerySchema.safeParse({}).success).toBe(true);
    // The API still accepts the old scope values (other clients may send them); the
    // panel simply no longer chooses one.
    for (const scope of ["all", "assigned", "queue"]) {
      expect(shared.approvalInboxQuerySchema.safeParse({ scope }).success).toBe(true);
    }
  });

  test("coordinator submission matches submitEventSchema", async () => {
    const src = [
      await source("features/CoordinatorPanel.tsx"),
      await source("features/EventApprovals.tsx"),
    ].join("\n");
    expect(src).toContain("expectedRevision:");
    expect(src).toContain("assignedApproverId:");
    const parsed = shared.submitEventSchema.safeParse({
      expectedRevision: 1,
      requests: [
        {
          type: "ORGANIZE",
          title: "Permission to organize",
          isRequired: true,
          assignedApproverId: "00000000-0000-4000-8000-000000000012",
          resources: [],
        },
        {
          type: "RESOURCE_USE",
          title: "Lab booking",
          isRequired: true,
          assignedApproverId: "00000000-0000-4000-8000-000000000012",
          resources: [
            {
              resourceUnitId: "00000000-0000-4000-8000-000000000071",
              startsAt: "2026-12-01T09:00:00.000Z",
              endsAt: "2026-12-01T12:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("the draft form offers every admission mode, straight from the shared list", async () => {
    const src = await source("features/CoordinatorPanel.tsx");
    // The old form hardcoded FCFS + MANUAL, so a coordinator could not create a quiz-based
    // event at all. It must now render ADMISSION_MODES rather than a hand-written list.
    expect(src).toContain("ADMISSION_MODES.map(");
    expect(src).not.toMatch(/<option value="(FCFS|MANUAL|QUIZ_TOP_N|QUIZ_FIRST_QUALIFIED)">/);
    // Quiz modes are only valid once a quiz is attached; FCFS/MANUAL always are.
    for (const admissionMode of shared.ADMISSION_MODES) {
      const quizMode = admissionMode.startsWith("QUIZ_");
      expect(
        shared.validateAdmissionForAudience("COLLEGE_ONLY", admissionMode, {
          hasLinkedQuiz: quizMode,
        }),
      ).toEqual([]);
      if (quizMode) {
        // Offering it before a quiz exists must still produce the coaching message.
        expect(
          shared.validateAdmissionForAudience("COLLEGE_ONLY", admissionMode).length,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("the client never hardcodes a backend host", async () => {
    for (const file of ["lib/api.ts", "App.tsx", "features/CoordinatorPanel.tsx"]) {
      // Strip comments: the client documents the rule in prose.
      const code = (await source(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
      expect(code).not.toContain("http://localhost");
    }
    const api = await source("lib/api.ts");
    expect(api).toContain("`/api/v1${path}`");
  });
});
