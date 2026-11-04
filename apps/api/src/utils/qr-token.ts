import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

/**
 * Access-QR tokens.
 *
 * The participant's app shows a token that changes every few seconds. It is
 * signed, so a scanner can reject a forged or edited code without a database
 * round trip, and it carries a random nonce that is recorded on first use, so a
 * screenshot cannot be replayed by a friend.
 *
 * The signing key is derived from the access-token secret with a distinct label
 * rather than adding another required environment variable. QR_SIGNING_SECRET
 * may be set to rotate QR signing independently of sessions.
 */

const LABEL = "campusops:access-qr:v1";

function key(): Buffer {
  const secret = env.QR_SIGNING_SECRET ?? env.JWT_ACCESS_SECRET;
  // Auth cannot run without one of these; fail loudly rather than sign with an
  // empty key if the process was somehow started misconfigured.
  if (!secret) throw new Error("QR signing requires QR_SIGNING_SECRET or JWT_ACCESS_SECRET.");
  return createHmac("sha256", secret).update(LABEL).digest();
}

export type QrPayload = {
  /** Pass public id — never the internal primary key. */
  p: string;
  /** Checkpoint the code was minted for. */
  c: string;
  /** Expiry, epoch milliseconds. */
  e: number;
  /** Random nonce, base64url. */
  n: string;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signQrPayload(payload: QrPayload): string {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", key()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

export type VerifyResult =
  | { ok: true; payload: QrPayload; nonceHash: string }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

export function verifyQrToken(token: string, now = Date.now()): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };
  const [body, mac] = parts as [string, string];
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const expected = createHmac("sha256", key()).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "BAD_SIGNATURE" };

  let payload: QrPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as QrPayload;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (
    typeof payload.p !== "string" ||
    typeof payload.c !== "string" ||
    typeof payload.e !== "number" ||
    typeof payload.n !== "string"
  )
    return { ok: false, reason: "MALFORMED" };
  if (payload.e <= now) return { ok: false, reason: "EXPIRED" };

  return { ok: true, payload, nonceHash: hashNonce(token) };
}

/** Only the hash is stored, so the log cannot be used to mint a working code. */
export function hashNonce(token: string): string {
  return createHmac("sha256", key()).update(`nonce:${token}`).digest("hex");
}

export function newNonce(): string {
  return b64url(randomBytes(16));
}
