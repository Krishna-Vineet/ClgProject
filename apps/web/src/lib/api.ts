/**
 * Browser API client. Relative URLs only — never localhost — so the same build
 * works behind the Vite proxy and in production behind one origin.
 *
 * Session model: the access token lives in memory only. The refresh token is an
 * httpOnly cookie the browser sends automatically, so JavaScript never sees it.
 */

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  idempotencyKey?: string;
  /** Set for the refresh call itself so it cannot recurse. */
  skipAuthRefresh?: boolean;
  signal?: AbortSignal;
};

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

/** Called when a refresh fails, so the shell can drop back to the sign-in screen. */
export function setSessionLostHandler(fn: (() => void) | null) {
  onSessionLost = fn;
}

/**
 * Single-flight refresh. Without this, a page that fires six requests at once
 * would spend six refresh tokens and trip reuse detection, signing the user out.
 */
let refreshInFlight: Promise<string | null> | null = null;

export async function refreshSession(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: "web" }),
      });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const json = await res.json().catch(() => null);
      const token = json?.data?.accessToken ?? null;
      accessToken = token;
      return token;
    } catch {
      return null;
    } finally {
      // Release on the next tick so callers awaiting this promise all see it.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();
  return refreshInFlight;
}

async function send(path: string, body: unknown, options: RequestOptions, token: string | null) {
  return fetch(`/api/v1${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * `body` is the JSON payload. Pass `{}` for a bodyless POST. Omit it for GET.
 * A 401 triggers one transparent refresh and replay; a second 401 ends the session.
 */
export async function api<T>(
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  let res = await send(path, body, options, accessToken);

  if (res.status === 401 && !options.skipAuthRefresh) {
    const token = await refreshSession();
    if (token) {
      res = await send(path, body, options, token);
    } else {
      onSessionLost?.();
    }
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiClientError(
      json?.error?.message ?? `Request failed (${res.status})`,
      json?.error?.code ?? "UNKNOWN",
      res.status,
      json?.error?.details,
    );
  }
  return json.data as T;
}

/** Fetch a binary payload (PDF, ID proof) with the same auth and refresh rules. */
export async function apiBlob(path: string): Promise<Blob> {
  let res = await send(path, undefined, { method: "GET" }, accessToken);
  if (res.status === 401) {
    const token = await refreshSession();
    if (token) res = await send(path, undefined, { method: "GET" }, token);
    else onSessionLost?.();
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ApiClientError(
      json?.error?.message ?? `Download failed (${res.status})`,
      json?.error?.code ?? "UNKNOWN",
      res.status,
    );
  }
  return res.blob();
}

/** Trigger a browser download for an authenticated endpoint. */
export async function downloadBlob(path: string, filename: string) {
  const blob = await apiBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function query(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export type Page<T> = {
  items: T[];
  limit: number;
  offset: number;
  hasMore?: boolean;
  total?: number;
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    const issues = err.details?.issues;
    if (Array.isArray(issues)) {
      const messages = issues
        .map((issue) =>
          issue && typeof issue === "object" && "message" in issue ? String(issue.message) : null,
        )
        .filter((message): message is string => Boolean(message));
      if (messages.length)
        return `${err.message.replace(/[.:]\s*$/, "")}: ${[...new Set(messages)].join("; ")}`;
    }
    const fields = err.details?.fields;
    if (fields && typeof fields === "object") {
      const first = Object.entries(fields as Record<string, unknown>)[0];
      if (first) return `${err.message} (${first[0]}: ${String(first[1])})`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** True when the failure means "you may not do this", not "something broke". */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiClientError && (err.status === 403 || err.status === 404);
}
