import { env } from "../config/env";

type Fields = Record<string, unknown>;

const REDACT = /token|secret|password|authorization|cookie|otp/i;

function clean(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = REDACT.test(key) ? "[redacted]" : value;
  }
  return out;
}

/**
 * One log line per event. JSON in production so a free host's log viewer can be
 * searched by request id; readable text locally. No third-party service needed.
 */
function write(level: "info" | "warn" | "error", message: string, fields: Fields = {}) {
  const payload = { level, message, time: new Date().toISOString(), ...clean(fields) };
  if (env.LOG_JSON) {
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    return;
  }
  const suffix = Object.entries(payload)
    .filter(([key]) => !["level", "message", "time"].includes(key))
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" ");
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    `[${level}] ${message}${suffix ? ` ${suffix}` : ""}`,
  );
}

export const log = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
