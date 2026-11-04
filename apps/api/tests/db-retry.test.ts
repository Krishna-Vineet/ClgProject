import { describe, expect, test } from "bun:test";
import {
  hasTransientSocketError,
  retryOnConnectionLoss,
  retryTransaction,
  retryTransientRead,
} from "../src/utils/db-retry";

const socketError = (code: string) => Object.assign(new Error(`write ${code}`), { code });

describe("transient database read retry", () => {
  test("retries one read after a nested ECONNRESET", async () => {
    let calls = 0;
    const value = await retryTransientRead(async () => {
      calls += 1;
      if (calls === 1) {
        const drizzleError = new Error("Drizzle query failed", {
          cause: socketError("ECONNRESET"),
        });
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

describe("pooled-connection loss", () => {
  // The failure this project hit in production: Neon's pooler closes an idle
  // backend and the client only discovers it when the next write is attempted.
  test("recognises the CONNECTION_CLOSED error a pooler produces", () => {
    const error = new Error(
      "write CONNECTION_CLOSED [ep-x-pooler.c-2.ap-southeast-1.aws.neon.tech:5432]",
    );
    (error as { code?: string }).code = "CONNECTION_CLOSED";
    expect(hasTransientSocketError(error)).toBe(true);
  });

  test("recognises the code when it is wrapped by Drizzle", () => {
    const wrapped = Object.assign(new Error("Drizzle query failed"), {
      cause: socketError("CONNECTION_CLOSED"),
    });
    expect(hasTransientSocketError(wrapped)).toBe(true);
  });

  test("does not mistake a semantic error for a connection failure", () => {
    // These must surface immediately: retrying a unique violation three times
    // would turn a clear 409 into a slow 409.
    expect(hasTransientSocketError(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
    expect(hasTransientSocketError(Object.assign(new Error("bad"), { code: "22P02" }))).toBe(false);
  });

  test("a read is retried up to the attempt limit, then surfaces the real error", async () => {
    let calls = 0;
    await expect(
      retryTransientRead(async () => {
        calls += 1;
        throw socketError("CONNECTION_CLOSED");
      }),
    ).rejects.toThrow("CONNECTION_CLOSED");
    expect(calls).toBe(3);
  });

  test("a read that recovers on the third attempt succeeds", async () => {
    let calls = 0;
    const value = await retryTransientRead(async () => {
      calls += 1;
      if (calls < 3) throw socketError("CONNECTION_CLOSED");
      return "recovered";
    });
    expect(value).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("a transaction is replayed from the start when the connection dies", async () => {
    // Safe because the connection dropping rolls the transaction back: replaying
    // it cannot double-apply anything.
    let attempts = 0;
    const value = await retryTransaction(async () => {
      attempts += 1;
      if (attempts === 1) throw socketError("CONNECTION_CLOSED");
      return "committed";
    });
    expect(value).toBe("committed");
    expect(attempts).toBe(2);
  });

  test("an unsafe operation is never retried", async () => {
    let calls = 0;
    await expect(
      retryOnConnectionLoss(
        async () => {
          calls += 1;
          throw socketError("CONNECTION_CLOSED");
        },
        { safe: false },
      ),
    ).rejects.toThrow("CONNECTION_CLOSED");
    expect(calls).toBe(1);
  });
});
