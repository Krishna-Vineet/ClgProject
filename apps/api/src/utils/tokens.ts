import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashToken(token: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${token}`).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hashIp(ip: string | undefined, pepper: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`${pepper}:ip:${ip}`).digest("hex");
}
