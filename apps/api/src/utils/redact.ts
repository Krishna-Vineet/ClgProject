const SENSITIVE_KEYS = new Set([
  "password",
  "passwordHash",
  "password_hash",
  "refreshToken",
  "refresh_token",
  "refreshTokenHash",
  "refresh_token_hash",
  "token",
  "tokenHash",
  "token_hash",
  "collegeIdNumber",
  "college_id_number",
  "authorization",
]);

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}
