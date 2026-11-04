import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/config/env";

describe("env validation", () => {
  test("defaults are safe", () => {
    const env = readEnv({ DEMO_MODE: "true" });
    expect(env.PORT).toBe(8787);
    expect(env.CAMPUS_TIMEZONE).toBe("Asia/Kolkata");
    expect(env.DATABASE_URL).toBeUndefined();
  });

  test("empty strings become undefined", () => {
    const env = readEnv({ DEMO_MODE: "true", DATABASE_URL: "", WEB_ORIGIN: "" });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.WEB_ORIGIN).toBe("http://localhost:5173");
  });

  test("invalid port fails", () => {
    expect(() => readEnv({ DEMO_MODE: "true", PORT: "not-a-port" })).toThrow();
  });
});
