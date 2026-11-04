/**
 * The consent notice shown on the student registration form.
 *
 * Shared so the browser, the mobile app and the API cannot drift: the version
 * stored next to `consent_accepted_at` is the version of the text below. Bump it
 * when the wording changes and existing users are asked again rather than being
 * presumed to have agreed to text they never saw.
 *
 * Kept dependency-free (both apps bundle it) — this module must not import Zod.
 */
export const CONSENT_POLICY = {
  version: "2026-11-01",
  summary:
    "CampusOps keeps your name, email, phone, roll number, college ID and event records so your institution can verify you and run its events. Staff of your institution can see these records within their role's scope. Ask your administrator for a copy or deletion of your data.",
} as const;

export function hasAcceptedCurrentPolicy(user: {
  consentAcceptedAt: string | Date | null;
  consentVersion: string | null;
}): boolean {
  return user.consentAcceptedAt !== null && user.consentVersion === CONSENT_POLICY.version;
}
