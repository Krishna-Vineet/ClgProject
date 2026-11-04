import { describe, expect, test } from "bun:test";
import { retryTransientRead } from "../src/utils/db-retry";

describe("transient database read retry", () => {
  test("retries one read after a nested ECONNRESET", async () => {
    let calls = 0;
    const value = await retryTransientRead(async () => {
      calls += 1;
      if (calls === 1) {
        const socketError = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        const drizzleError = new Error("Drizzle query failed", { cause: socketError });
        throw drizzleError;
      }
      return "row";
    });
    expect(value).toBe("row");
    expect(calls).toBe(2);
  });

  test("does not retry a non-transient database error", async () => {
    let calls = 0;
    await expect(
      retryTransientRead(async () => {
        calls += 1;
        throw Object.assign(new Error("invalid SQL"), { code: "42601" });
      }),
    ).rejects.toThrow("invalid SQL");
    expect(calls).toBe(1);
  });
});
