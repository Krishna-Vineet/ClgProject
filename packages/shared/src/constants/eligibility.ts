import type { AccountType } from "./roles";

/**
 * The unrestricted policy. Kept out of the schema module so the browser can use
 * it without pulling Zod into the bundle.
 */
export const defaultEligibilityPolicy: {
  version: 1;
  accountTypes: AccountType[];
  departmentIds: string[];
  graduationYears: number[];
  requireInvitation: boolean;
} = {
  version: 1,
  accountTypes: [],
  departmentIds: [],
  graduationYears: [],
  requireInvitation: false,
};
