import { z } from "zod";
import { ACCOUNT_TYPES } from "../constants/roles";

export { defaultEligibilityPolicy } from "../constants/eligibility";

/**
 * Fixed, server-evaluated policy. No arbitrary code or expressions.
 *
 * Every array is length-capped. Zod accumulates one issue object per failing
 * element with no early exit (CVE-2023-54404), so an unbounded array turns a
 * single request into a memory-exhaustion vector. The caps are far above any
 * real policy: an institution does not have 200 departments in one rule.
 */
export const eligibilityPolicySchema = z.object({
  version: z.literal(1).default(1),
  accountTypes: z.array(z.enum(ACCOUNT_TYPES)).max(ACCOUNT_TYPES.length).default([]),
  departmentIds: z.array(z.string().uuid()).max(200).default([]),
  graduationYears: z.array(z.number().int().min(2000).max(2100)).max(30).default([]),
  requireInvitation: z.boolean().default(false),
});

export type EligibilityPolicy = z.infer<typeof eligibilityPolicySchema>;
