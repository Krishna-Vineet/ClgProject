import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

describe("health routes", () => {
  test("live does not require database", async () => {
    const app = createApp();
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("ok");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("unknown route returns stable error", async () => {
    const app = createApp();
    const res = await app.request("/missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
