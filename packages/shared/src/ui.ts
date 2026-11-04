/**
 * Browser-safe entry point.
 *
 * The main barrel also exports the Zod request schemas, which the API needs but
 * the browser does not. Importing that barrel would ship Zod and every validator
 * to every signed-in user, so web code imports this module instead.
 */
export * from "./constants/eligibility";
export * from "./constants/events";
export * from "./constants/operations";
export * from "./constants/roles";
export * from "./permissions/roles";
export * from "./types/api";
export * from "./domain/access";
export * from "./domain/approvals";
export * from "./domain/eligibility";
export * from "./domain/events";
export * from "./domain/quiz";
export * from "./domain/resources";
export * from "./domain/time";
