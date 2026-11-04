import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "../src/middleware/error-handler";

function appThrowing(error: Error) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/boom", () => {
    throw error;
  });
  return app;
}

describe("database schema errors", () => {
  test("a missing column is an actionable 503, not an unexplained 500", async () => {
    const cause = Object.assign(new Error('column "phone_verified_at" does not exist'), {
      code: "42703",
      detail: 'column "phone_verified_at" does not exist',
    });
    const error = new Error("Failed query: select ... from users", { cause });
    const res = await appThrowing(error).request("/boom");

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("DATABASE_SCHEMA_OUT_OF_DATE");
    expect(body.error.message).toContain("pending migrations");
  });

  test("a missing table is treated the same way", async () => {
    const cause = Object.assign(new Error('relation "users" does not exist'), { code: "42P01" });
    const error = new Error("Failed query", { cause });
    const res = await appThrowing(error).request("/boom");

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DATABASE_SCHEMA_OUT_OF_DATE");
  });

  test("an unknown application error stays a 500", async () => {
    const res = await appThrowing(new Error("something broke")).request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
