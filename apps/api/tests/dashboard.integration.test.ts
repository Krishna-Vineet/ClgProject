import { beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import { users } from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/** Dashboard counts must be role-scoped and the /me/events filters must work. */
const app = createApp();
// biome-ignore lint/suspicious/noExplicitAny: dynamic API response bodies in tests
type Body = Record<string, any>;
// Own fixture password: other suites rewrite the seeded demo hashes, so this
// suite must not depend on whatever ran before it.
const PW = "Dashboard-Test-Password!";
const DEMO_EMAILS = [
  "principal@demo.campusops.local",
  "hoddean.cse@demo.campusops.local",
  "faculty.cse@demo.campusops.local",
  "coding.lead@demo.campusops.local",
  "student.verified@demo.campusops.local",
];

beforeAll(async () => {
  const { db } = getDb();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(PW) })
    .where(inArray(users.email, DEMO_EMAILS));
});

async function login(email: string) {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PW, client: "mobile" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Body).data.accessToken as string;
}
async function get(path: string, token: string) {
  const res = await app.request(`/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: (await res.json()) as Body };
}

describe("management dashboard", () => {
  test("requires authentication", async () => {
    const res = await app.request("/api/v1/me/dashboard");
    expect(res.status).toBe(401);
  });

  test("admin sees institution scope with exact totals and a 14-day trend", async () => {
    const token = await login("principal@demo.campusops.local");
    const { status, json } = await get("/me/dashboard", token);
    expect(status).toBe(200);
    const d = json.data;
    expect(d.scope).toBe("INSTITUTION");
    expect(d.events.total).toBeGreaterThanOrEqual(d.events.live + d.events.upcoming);
    expect(d.confirmationTrend).toHaveLength(14);
    expect(d.upcoming.length).toBeLessThanOrEqual(6);
    for (const e of d.upcoming) expect(e.confirmed).toBeGreaterThanOrEqual(0);
  });

  test("trend day keys follow the campus timezone, not UTC", async () => {
    const token = await login("principal@demo.campusops.local");
    const { json } = await get("/me/dashboard", token);
    const days: string[] = json.data.confirmationTrend.map((d: Body) => d.day);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.CAMPUS_TIMEZONE || "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const today = fmt.format(new Date(json.data.generatedAt));
    expect(days.at(-1)).toBe(today);
    expect(new Set(days).size).toBe(14);
    expect([...days].sort()).toEqual(days);
  });

  test("coordinator scope is limited to their clubs; a student cannot read it", async () => {
    const lead = await login("coding.lead@demo.campusops.local");
    const student = await login("student.verified@demo.campusops.local");
    const admin = await login("principal@demo.campusops.local");
    const l = (await get("/me/dashboard", lead)).json.data;
    const a = (await get("/me/dashboard", admin)).json.data;
    expect(l.scope).toBe("CLUBS");
    expect(l.events.total).toBeLessThanOrEqual(a.events.total);
    expect(l.work.verificationPending).toBe(0);
    // Students have no management dashboard data (empty scope, not an error leak).
    const s = await get("/me/dashboard", student);
    expect(s.status).toBe(200);
    expect(s.json.data.events.total).toBe(0);
    expect(s.json.data.work.approvalsPending).toBe(0);
  });

  test("HOD/Dean sees department scope, and no verification queue they cannot act on", async () => {
    const token = await login("hoddean.cse@demo.campusops.local");
    const d = (await get("/me/dashboard", token)).json.data;
    expect(d.scope).toBe("DEPARTMENT");
    // Verifying a student is a FACULTY action (`GET /faculty/verification-queue`
    // is faculty-only), so an HOD/Dean dashboard must not advertise a pending
    // verification count they have no page to clear. Their student detail page
    // carries the verification state instead. This used to assert >= 1, which is
    // the dead end that was reported.
    expect(d.work.verificationPending).toBe(0);
  });

  test("/me/events honours status and q filters", async () => {
    const token = await login("coding.lead@demo.campusops.local");
    const live = (await get("/me/events?status=LIVE&limit=100", token)).json.data;
    expect(live.items.every((e: { status: string }) => e.status === "LIVE")).toBe(true);
    const none = (await get("/me/events?q=zzzz-no-such-event&limit=10", token)).json.data;
    expect(none.items).toHaveLength(0);
    expect(none.total).toBe(0);
    const all = (await get("/me/events?limit=100", token)).json.data;
    expect(all.total).toBeGreaterThanOrEqual(live.total);
  });
});
