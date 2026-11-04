import { randomBytes } from "node:crypto";

/** Collision-safe, readable slugs. Never derived from user IDs or emails. */
export function slugify(input: string, maxLength = 60): string {
  const base = input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return base || "event";
}

export function uniqueSlug(input: string): string {
  return `${slugify(input)}-${randomBytes(3).toString("hex")}`;
}

export function unitCode(resourceCode: string, label: string, index: number): string {
  const base = slugify(`${resourceCode}-${label}`, 32).toUpperCase();
  return `${base}-${String(index + 1).padStart(2, "0")}`;
}
