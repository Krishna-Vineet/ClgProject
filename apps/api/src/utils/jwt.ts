import { sign, verify } from "hono/jwt";

export type AccessPayload = {
  sub: string;
  sid: string;
  accountType: "COLLEGE_STUDENT" | "OUTSIDER_STUDENT" | "STAFF";
  exp: number;
  iat: number;
};

export async function signAccessToken(
  payload: Omit<AccessPayload, "exp" | "iat">,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ ...payload, iat: now, exp: now + ttlSeconds }, secret, "HS256");
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessPayload> {
  const payload = await verify(token, secret, "HS256");
  if (
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Invalid access token payload");
  }
  return payload as AccessPayload;
}
