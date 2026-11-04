import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiClientError,
  api,
  errorMessage,
  isForbidden,
  query,
  refreshSession,
  setAccessToken,
  setSessionLostHandler,
} from "./api";

/**
 * The browser client decides what a user sees when something goes wrong, and it
 * owns the one place a stale access token is repaired. None of it had a test: a
 * regression here is a blank screen or a sign-out loop, not a failing build.
 */
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
  setAccessToken(null);
  setSessionLostHandler(null);
});

describe("browser API client", () => {
  test("relative URLs only: the same build works behind the Vite proxy and in production", async () => {
    stubFetch(() => Response.json({ data: { ok: true } }));
    await api("/me");
    expect(calls[0]?.url).toBe("/api/v1/me");
    expect(calls[0]?.url.startsWith("/")).toBe(true);
  });

  test("a 401 is repaired once, then replayed with the refreshed token", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      const auth = calls.at(-1)?.init?.headers as Record<string, string> | undefined;
      const token = auth?.authorization ?? "none";
      seen.push(`${url} ${token}`);
      if (url.endsWith("/auth/refresh"))
        return Response.json({ data: { accessToken: "new-token" } });
      if (token === "Bearer old-token") return new Response("{}", { status: 401 });
      return Response.json({ data: { id: "user-1" } });
    });

    setAccessToken("old-token");
    const result = await api<{ id: string }>("/me");
    expect(result.id).toBe("user-1");
    // Three calls: the 401, the refresh, the replay.
    expect(seen.length).toBe(3);
    expect(seen[1]).toContain("/auth/refresh");
    expect(seen[2]).toContain("Bearer new-token");
  });

  test("a failed refresh ends the session exactly once and surfaces the original error", async () => {
    stubFetch((url) =>
      url.endsWith("/auth/refresh")
        ? new Response("{}", { status: 401 })
        : Response.json(
            { error: { code: "UNAUTHENTICATED", message: "Session is no longer valid." } },
            { status: 401 },
          ),
    );
    let lost = 0;
    setSessionLostHandler(() => {
      lost += 1;
    });
    setAccessToken("stale");
    await expect(api("/me")).rejects.toBeInstanceOf(ApiClientError);
    expect(lost).toBe(1);
  });

  test("concurrent requests share one refresh, so a page load cannot burn a token", async () => {
    let refreshes = 0;
    stubFetch((url) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes += 1;
        return Response.json({ data: { accessToken: "token-2" } });
      }
      return Response.json({ data: { ok: true } });
    });
    setAccessToken(null);
    await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(refreshes).toBe(1);
  });

  test("error messages lead with the field the API complained about", () => {
    const err = new ApiClientError("Request validation failed.", "VALIDATION_ERROR", 400, {
      issues: [{ message: "Use a college email." }, { message: "Use a college email." }],
    });
    const message = errorMessage(err);
    // The trailing full stop is replaced by the colon that introduces the detail.
    expect(message).toBe("Request validation failed: Use a college email.");
    expect(message).toContain("Use a college email.");
    // Duplicates collapse: one point, said once.
    expect(message.match(/Use a college email/g)?.length).toBe(1);
  });

  test("a non-JSON failure still produces a usable message", () => {
    expect(errorMessage(new ApiClientError("Request failed (502)", "UNKNOWN", 502))).toBe(
      "Request failed (502)",
    );
    expect(errorMessage(new Error("offline"))).toBe("offline");
    expect(errorMessage(undefined)).toBe("Something went wrong.");
  });

  test("403 and 404 are 'you may not', not 'it broke'", () => {
    expect(isForbidden(new ApiClientError("no", "FORBIDDEN", 403))).toBe(true);
    expect(isForbidden(new ApiClientError("no", "NOT_FOUND", 404))).toBe(true);
    expect(isForbidden(new ApiClientError("no", "INTERNAL_ERROR", 500))).toBe(false);
    expect(isForbidden(new Error("no"))).toBe(false);
  });

  test("query strings omit empty values instead of sending 'undefined'", () => {
    expect(query({ q: "", limit: 20, offset: 0, status: undefined, x: null })).toBe(
      "?limit=20&offset=0",
    );
    expect(query({})).toBe("");
  });
});
