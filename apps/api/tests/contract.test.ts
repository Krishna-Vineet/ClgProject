import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

const app = createApp();
const stamp = Date.now();
const PASSWORD = "Contract-Test-Password!";

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: (await res.json()) as {
      data?: Record<string, unknown> & {
        items?: unknown[];
        verification?: { challengeId: string; demoOtp: string };
        accessToken?: string;
      };
      error?: { code: string; message: string };
    },
  };
}

async function activeOutsider() {
  const email = `contract.${stamp}.${Math.random().toString(36).slice(2)}@test.campusops.local`;
  const reg = await req("POST", "/api/v1/auth/register/outsider", {
    email,
    password: PASSWORD,
    fullName: "Contract Test",
    institutionName: "Test College",
    client: "mobile",
  });
  const v = reg.json.data?.verification as { challengeId: string; demoOtp: string };
  await req("POST", "/api/v1/auth/verify-email", { challengeId: v.challengeId, otp: v.demoOtp });
  const login = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  return login.json.data?.accessToken as string;
}

describe("API contract", () => {
  test("validation errors are stable and do not leak internals", async () => {
    const r = await req("POST", "/api/v1/auth/register/outsider", { email: "not-an-email" });
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe("VALIDATION_ERROR");
    expect(r.json.error?.message).toBeTruthy();
  });

  test("protected routes require auth and unknown routes are stable", async () => {
    expect((await req("GET", "/api/v1/me")).status).toBe(401);
    const missing = await req("GET", "/api/v1/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.json.error?.code).toBe("NOT_FOUND");
  });

  test("list endpoints expose bounded pagination metadata", async () => {
    const token = await activeOutsider();
    for (const path of ["/api/v1/clubs?limit=1&offset=0", "/api/v1/events?limit=1&offset=0"]) {
      const r = await req("GET", path, undefined, token);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.json.data?.items)).toBe(true);
      expect(r.json.data?.limit).toBe(1);
      expect(r.json.data?.offset).toBe(0);
      expect(typeof r.json.data?.hasMore).toBe("boolean");
    }
    const bad = await req("GET", "/api/v1/events?limit=1000", undefined, token);
    expect(bad.status).toBe(400);
  });

  test("hidden records return 404, not 403, to outsiders", async () => {
    const token = await activeOutsider();
    const r = await req(
      "GET",
      "/api/v1/events/00000000-0000-4000-8000-000000000080",
      undefined,
      token,
    );
    expect(r.status).toBe(404);
  });

  test("file presign rejects event-scoped purposes until Phase 3 authorization exists", async () => {
    const token = await activeOutsider();
    const r = await req(
      "POST",
      "/api/v1/files/presign",
      { purpose: "EVENT_REPORT", mimeType: "application/pdf", sizeBytes: 1024 },
      token,
    );
    expect(r.status).toBe(403);
    expect(r.json.error?.code).toBe("FORBIDDEN");
  });
});
