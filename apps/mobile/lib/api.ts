import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Native refresh tokens live in the device keychain/keystore. The browser
 * preview is a review surface, not a student web portal: its token stays in
 * memory and disappears on reload. No token is written to localStorage.
 */
const REFRESH_KEY = "campusops.refresh";
let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let sessionLost: (() => void) | null = null;

const configured = Constants.expoConfig?.extra?.apiUrl;
export const API_ORIGIN = Platform.OS === "web" ? "" : String(configured ?? "");
const BASE = `${API_ORIGIN}/api/v1`;

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

export function onSessionLost(fn: (() => void) | null) {
  sessionLost = fn;
}
export function hasSession() {
  return Boolean(refreshToken);
}

async function storeRefresh(token: string | null) {
  refreshToken = token;
  if (Platform.OS === "web") return;
  if (token)
    await SecureStore.setItemAsync(REFRESH_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  else await SecureStore.deleteItemAsync(REFRESH_KEY);
}

export type AuthPayload = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; fullName: string; email: string; status: string; accountType: string };
};

export async function adoptSession(payload: AuthPayload) {
  accessToken = payload.accessToken;
  await storeRefresh(payload.refreshToken);
}

export async function clearSession() {
  accessToken = null;
  await storeRefresh(null);
}

async function parse<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => null);
  if (!res.ok)
    throw new ApiClientError(
      json?.error?.message ?? `Request failed (${res.status})`,
      json?.error?.code ?? "UNKNOWN",
      res.status,
      json?.error?.details,
    );
  return json.data as T;
}

async function send(
  path: string,
  body: unknown,
  method: string,
  token: string | null,
  key?: string,
  signal?: AbortSignal,
) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
}

/** Single-flight rotation: parallel 401s must not spend the same token twice. */
export async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!refreshToken) return false;
    try {
      const res = await send("/auth/refresh", { client: "mobile", refreshToken }, "POST", null);
      const data = await parse<AuthPayload>(res);
      await adoptSession(data);
      return true;
    } catch (err) {
      // A network failure is not a revoked session. Keep the refresh token so
      // the next request can retry; only an auth rejection clears it.
      if (err instanceof ApiClientError && err.status < 500) {
        await clearSession();
        sessionLost?.();
      }
      return false;
    } finally {
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();
  return refreshInFlight;
}

export async function restoreSession(): Promise<boolean> {
  if (Platform.OS !== "web") {
    try {
      refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
    } catch {
      refreshToken = null;
    }
  }
  return refreshSession();
}

type Options = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  idempotencyKey?: string;
  signal?: AbortSignal;
};
export async function api<T>(path: string, body?: unknown, options: Options = {}): Promise<T> {
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  let res = await send(path, body, method, accessToken, options.idempotencyKey, options.signal);
  if (res.status === 401 && refreshToken) {
    const renewed = await refreshSession();
    if (renewed)
      res = await send(path, body, method, accessToken, options.idempotencyKey, options.signal);
    else if (!hasSession()) sessionLost?.();
  }
  return parse<T>(res);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    const issues = err.details?.issues;
    if (Array.isArray(issues) && issues[0]?.message) return String(issues[0].message);
    return err.message;
  }
  if (err instanceof Error && err.message === "Failed to fetch")
    return "Cannot reach the API. Check your connection and API address.";
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}

export type Page<T> = { items: T[]; limit: number; offset: number; hasMore?: boolean };
export function query(params: Record<string, string | number | undefined>) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length
    ? `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`
    : "";
}
