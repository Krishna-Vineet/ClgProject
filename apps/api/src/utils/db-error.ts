/**
 * PostgreSQL error inspection.
 *
 * Drizzle wraps driver errors (the original is on `.cause`), and the depth of
 * that wrapping has changed between releases. Every check here therefore goes
 * through `pgCode`, which walks the cause chain, rather than reading `.code`
 * off the top-level object — reading it directly silently stopped recognising
 * constraint violations after a Drizzle upgrade and turned 409s into 500s.
 */

export function pgCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

export function pgDetail(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("detail" in current) {
      const detail = (current as { detail?: unknown }).detail;
      if (typeof detail === "string") return detail;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("constraint" in current) {
      const value = (current as { constraint?: unknown }).constraint;
      if (typeof value === "string") return value;
    }
    if ("constraint_name" in current) {
      const value = (current as { constraint_name?: unknown }).constraint_name;
      if (typeof value === "string") return value;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

/** unique_violation */
export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === "23505";
}

/** check_violation */
export function isCheckViolation(err: unknown): boolean {
  return pgCode(err) === "23514";
}

/** foreign_key_violation */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === "23503";
}

/** exclusion_violation — raised by the resource overlap constraint. */
export function isExclusionViolation(err: unknown): boolean {
  return pgCode(err) === "23P01";
}
