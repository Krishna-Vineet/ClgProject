import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { createMiddleware } from "hono/factory";
import { authConfig, env } from "../config/env";
import { getDb } from "../db/client";
import { ApiError } from "../utils/api-error";
import { hashToken } from "../utils/tokens";

/**
 * Resolve the caller's address.
 *
 * Behind a proxy we read X-Forwarded-For from the trusted end of the chain (the
 * right-most entries are appended by infrastructure we control), never the
 * client-supplied left edge. Without trusted proxy headers we use the socket
 * address. The old "direct" fallback silently put every anonymous caller in one
 * shared bucket, which turns a burst of logins into a campus-wide lockout.
 */
export function clientIp(c: Context): string {
  if (env.TRUST_PROXY_HEADERS) {
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (chain.length > 0) {
      const index = Math.max(0, chain.length - env.TRUSTED_PROXY_HOPS);
      return chain[index] ?? "unknown";
    }
    const real = c.req.header("x-real-ip")?.trim();
    if (real) return real;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * `keyBy: "user"` buckets by account instead of address. Participant-facing
 * endpoints need it: at a venue every student shares the campus Wi-Fi's public
 * IP, so an address bucket would throttle the whole crowd as if it were one
 * person. Sign-in and registration stay address-keyed because there is no
 * authenticated account yet.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  prefix: string;
  keyBy?: "ip" | "user";
}) {
  return createMiddleware(async (c, next) => {
    if (process.env.NODE_ENV === "test") return next();
    const { db } = getDb();
    const cfg = authConfig();
    const identity =
      options.keyBy === "user" ? (c.get("auth")?.user.id ?? clientIp(c)) : clientIp(c);
    const keyHash = hashToken(`${options.prefix}:${identity}`, cfg.refreshPepper) ?? "";
    const expiresAt = new Date(Date.now() + options.windowMs);
    const rows = await db.execute<{ count: number }>(sql`
      INSERT INTO rate_limit_buckets (key_hash, count, expires_at)
      VALUES (${keyHash}, 1, ${expiresAt.toISOString()})
      ON CONFLICT (key_hash) DO UPDATE SET
        count = CASE WHEN rate_limit_buckets.expires_at < now() THEN 1 ELSE rate_limit_buckets.count + 1 END,
        expires_at = CASE WHEN rate_limit_buckets.expires_at < now() THEN ${expiresAt.toISOString()}::timestamptz ELSE rate_limit_buckets.expires_at END
      RETURNING count
    `);
    const count = Number(rows[0]?.count ?? 1);
    const max = options.max * env.RATE_LIMIT_SCALE;
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - count)));
    if (count > max) throw new ApiError("RATE_LIMITED", "Too many requests. Try again later.");
    await next();
  });
}
