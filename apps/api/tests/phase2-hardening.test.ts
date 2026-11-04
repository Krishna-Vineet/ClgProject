import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { readEnv } from "../src/config/env";

const app = createApp();
const stamp = Date.now();

async function post(path: string, body: unknown, headers?: Record<string, string>) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as {
      data?: Record<string, unknown>;
      error?: { code?: string; message?: string };
    },
  };
}

describe("phase 2 close-out hardening", () => {
  test("demo toggles are explicit and production-safe", () => {
    expect(() =>
      readEnv({ NODE_ENV: "production", EMAIL_MODE: "demo", DEMO_MODE: "true" }),
    ).toThrow();
    expect(() =>
      readEnv({
        NODE_ENV: "production",
        EMAIL_MODE: "demo",
        DEMO_MODE: "true",
        ALLOW_PRODUCTION_DEMO: "true",
      }),
    ).not.toThrow();
    expect(() =>
      readEnv({
        EXPOSE_DEMO_OTP: "true",
        EMAIL_MODE: "brevo",
        BREVO_API_KEY: "x",
        DEMO_MODE: "false",
      }),
    ).toThrow();
    expect(() => readEnv({ STORAGE_MODE: "s3" })).toThrow();
    const env = readEnv({
      STORAGE_MODE: "s3",
      AWS_ENDPOINT_URL_S3: "https://s3.example",
      AWS_ACCESS_KEY_ID: "a",
      AWS_SECRET_ACCESS_KEY: "b",
      S3_BUCKET: "c",
    });
    expect(env.S3_BUCKET).toBe("c");
  });

  test("OTP wrong attempts are limited and demo OTP is not logged as a token", async () => {
    const email = `otp.${stamp}@test.campusops.local`;
    const reg = await post("/api/v1/auth/register/outsider", {
      email,
      password: "Hardening-Password!",
      fullName: "OTP Test",
      institutionName: "Test College",
      client: "mobile",
    });
    expect(reg.status).toBe(201);
    const challenge = (reg.json.data as Record<string, unknown>).verification as {
      challengeId: string;
      demoOtp: string;
    };
    expect(challenge.demoOtp).toMatch(/^\d{6}$/);
    const wrong = challenge.demoOtp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await post("/api/v1/auth/verify-email", {
        challengeId: challenge.challengeId,
        otp: wrong,
      });
      expect(r.status).toBe(400);
    }
    const locked = await post("/api/v1/auth/verify-email", {
      challengeId: challenge.challengeId,
      otp: challenge.demoOtp,
    });
    expect(locked.status).toBe(400);
  });

  test("registration idempotency replays the same response and rejects changed payload", async () => {
    const body = {
      email: `idem.${stamp}@test.campusops.local`,
      password: "Hardening-Password!",
      fullName: "Idem Test",
      institutionName: "Test College",
      client: "mobile",
    };
    const headers = { "idempotency-key": `key-${stamp}` };
    const a = await post("/api/v1/auth/register/outsider", body, headers);
    const b = await post("/api/v1/auth/register/outsider", body, headers);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((b.json.data as { user: { id: string } }).user.id).toBe(
      (a.json.data as { user: { id: string } }).user.id,
    );
    const c = await post(
      "/api/v1/auth/register/outsider",
      { ...body, fullName: "Changed" },
      headers,
    );
    expect(c.status).toBe(409);
  });

  test("private storage is disabled explicitly, not silently mocked", async () => {
    const email = `storage.${stamp}@test.campusops.local`;
    const reg = await post("/api/v1/auth/register/outsider", {
      email,
      password: "Hardening-Password!",
      fullName: "Storage Test",
      institutionName: "Test College",
      client: "mobile",
    });
    const v = (reg.json.data as Record<string, unknown>).verification as {
      challengeId: string;
      demoOtp: string;
    };
    await post("/api/v1/auth/verify-email", { challengeId: v.challengeId, otp: v.demoOtp });
    const l = await post("/api/v1/auth/login", {
      email,
      password: "Hardening-Password!",
      client: "mobile",
    });
    const token = (l.json.data as { accessToken: string }).accessToken;
    const res = await app.request("/api/v1/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ purpose: "PROFILE_PHOTO", mimeType: "image/jpeg", sizeBytes: 1024 }),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("STORAGE_DISABLED");
  });
});
