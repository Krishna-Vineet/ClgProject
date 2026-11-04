/**
 * Normalise an Indian campus phone number to E.164.
 *
 * The college is single-institution, so a bare 10-digit number is understood as
 * the campus country code. Numbers that already carry `+` or `00` keep their
 * country. Formatting characters are removed; anything that is not 8–15 digits
 * after normalisation is rejected rather than stored as decoration.
 */
export function normalizePhone(raw: string, countryCode = "91"): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let value = trimmed.replace(/[\s().-]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (!value.startsWith("+")) {
    if (!/^\d+$/.test(value)) return null;
    value = value.length === 10 ? `+${countryCode}${value}` : `+${value}`;
  }
  const digits = value.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Display form for a stored E.164 value: +91 98765 43210. */
export function formatPhone(value: string | null): string {
  if (!value) return "";
  if (value.startsWith("+91") && value.length === 13)
    return `+91 ${value.slice(3, 8)} ${value.slice(8)}`;
  return value;
}
