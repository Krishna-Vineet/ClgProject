import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import { clubMemberships, clubs, roleAssignments, users } from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/**
 * The staff and student directories are oversight surfaces: Admin sees the
 * institution, HOD/Dean sees one department, and nobody else gets the list.
 */
const app = createApp();
// biome-ignore lint/suspicious/noExplicitAny: dynamic API response bodies in tests
type Body = Record<string, any>;
const PW = "Directory-Test-Password!";
const DEMO_EMAILS = [
  "principal@demo.campusops.local",
  "hoddean.cse@demo.campusops.local",
  "faculty.cse@demo.campusops.local",
  "robotics.coordinator@demo.campusops.local",
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

describe("staff directory", () => {
  test("admin lists staff with phone, position and department filters", async () => {
    const token = await login("principal@demo.campusops.local");
    const all = await get("/admin/staff?limit=100", token);
    expect(all.status).toBe(200);
    expect(all.json.data.total).toBeGreaterThan(0);
    for (const staff of all.json.data.items) {
      expect(staff.position).toBeString();
      expect(staff).toHaveProperty("phone");
    }

    const seeded = await get("/admin/staff?q=principal@demo.campusops.local&limit=10", token);
    expect(seeded.json.data.items).toHaveLength(1);

    const others = await get("/admin/staff?position=OTHER&limit=100", token);
    expect(others.status).toBe(200);
    expect(others.json.data.items.length).toBeGreaterThan(0);
    expect(others.json.data.items.every((s: Body) => s.position === "OTHER")).toBe(true);

    const bySearch = await get("/admin/staff?q=hoddean&limit=100", token);
    expect(bySearch.json.data.items).toHaveLength(1);
    expect(bySearch.json.data.items[0].departmentName).toBeString();
  });

  test("provisioning takes a position and phone and accepts institution-wide staff", async () => {
    const token = await login("principal@demo.campusops.local");
    const email = `directory-${Date.now()}@example.test`;
    const res = await app.request("/api/v1/admin/staff", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `directory-staff-${Date.now()}`,
      },
      body: JSON.stringify({
        email,
        fullName: "Directory Test",
        phone: "+91 98111 22333",
        position: "ASSISTANT_PROFESSOR",
        departmentId: null,
      }),
    });
    expect(res.status).toBe(201);
    const detail = await get(`/admin/staff?q=${encodeURIComponent(email)}&limit=10`, token);
    expect(detail.json.data.items).toHaveLength(1);
    expect(detail.json.data.items[0].position).toBe("ASSISTANT_PROFESSOR");
    expect(detail.json.data.items[0].departmentId).toBeNull();
    expect(detail.json.data.items[0].phone).toContain("98111");
  });

  test("HOD/Dean reads the staff directory, narrowed to their own department", async () => {
    // Administrators asked for the Administration page to be usable by an
    // HOD/Dean for their own department. The route is no longer Admin-only, so
    // this asserts the scope instead of the refusal: they get a 200 whose rows
    // all belong to the department they hold a scoped role for.
    const token = await login("hoddean.cse@demo.campusops.local");
    const res = await get("/admin/staff?limit=100", token);
    expect(res.status).toBe(200);
    const departments = new Set(
      (res.json.data.items as Array<{ departmentId: string | null }>).map((i) => i.departmentId),
    );
    expect(departments.size).toBeGreaterThan(0);
    expect(departments.has(null)).toBe(false);
    expect(departments.size).toBe(1);
  });

  test("HOD/Dean is still refused roles, suspension and the audit log", async () => {
    const token = await login("hoddean.cse@demo.campusops.local");
    expect((await get("/admin/users?limit=5", token)).status).toBe(403);
    expect((await get("/admin/audit?limit=5", token)).status).toBe(403);
    expect((await get("/admin/setup", token)).status).toBe(403);
  });
});

describe("student directory", () => {
  test("admin sees every student and can filter by status", async () => {
    const token = await login("principal@demo.campusops.local");
    const all = await get("/faculty/students?limit=100", token);
    expect(all.status).toBe(200);
    expect(all.json.data.total).toBeGreaterThanOrEqual(all.json.data.items.length);
    const seeded = await get(
      "/faculty/students?q=student.verified@demo.campusops.local&limit=10",
      token,
    );
    expect(seeded.json.data.items).toHaveLength(1);

    const active = await get("/faculty/students?status=ACTIVE&limit=100", token);
    expect(active.json.data.items.every((s: Body) => s.status === "ACTIVE")).toBe(true);
  });

  test("HOD/Dean only sees students in their department", async () => {
    const hod = await login("hoddean.cse@demo.campusops.local");
    const res = await get("/faculty/students?limit=100", hod);
    expect(res.status).toBe(200);
    const departmentIds = new Set(
      res.json.data.items.map((s: Body) => s.profile.departmentId).filter(Boolean),
    );
    expect(departmentIds.size).toBe(1);
    const scoped = [...departmentIds][0];
    const filtered = await get(`/faculty/students?departmentId=${scoped}&limit=100`, hod);
    expect(filtered.json.data.items.length).toBe(res.json.data.items.length);
  });

  test("club coordinators and students cannot read the student directory", async () => {
    const coordinator = await login("robotics.coordinator@demo.campusops.local");
    const student = await login("student.verified@demo.campusops.local");
    expect((await get("/faculty/students", coordinator)).status).toBe(403);
    expect((await get("/faculty/students", student)).status).toBe(403);
  });
});

describe("event oversight", () => {
  test("Admin sees the institution; HOD/Dean sees only their department's clubs", async () => {
    const { db } = getDb();
    const admin = await login("principal@demo.campusops.local");
    const hod = await login("hoddean.cse@demo.campusops.local");
    const adminEvents = await get("/me/events?limit=100", admin);
    const hodEvents = await get("/me/events?limit=100", hod);
    expect(adminEvents.status).toBe(200);
    expect(hodEvents.status).toBe(200);
    expect(adminEvents.json.data.total).toBeGreaterThanOrEqual(hodEvents.json.data.total);

    const [hodUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "hoddean.cse@demo.campusops.local"));
    expect(hodUser).toBeDefined();
    const hodRoles = await db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, hodUser?.id ?? ""));
    const deptIds = hodRoles
      .filter((r) => r.role === "HOD_DEAN" && r.departmentId)
      .map((r) => r.departmentId as string);
    const departmentClubs = deptIds.length
      ? await db.select({ id: clubs.id }).from(clubs).where(inArray(clubs.departmentId, deptIds))
      : [];
    const memberships = await db
      .select({ clubId: clubMemberships.clubId })
      .from(clubMemberships)
      .where(eq(clubMemberships.userId, hodUser?.id ?? ""));
    const allowed = new Set([
      ...departmentClubs.map((c) => c.id),
      ...memberships.map((m) => m.clubId),
    ]);
    expect(hodEvents.json.data.items.length).toBeGreaterThan(0);
    for (const event of hodEvents.json.data.items) expect(allowed.has(event.clubId)).toBe(true);
  });
});

describe("club member visibility", () => {
  test("a coordinator can read their club's team but cannot manage it", async () => {
    const { db } = getDb();
    const [club] = await db.select().from(clubs).where(eq(clubs.slug, "demo-robotics-club"));
    expect(club).toBeDefined();
    const token = await login("robotics.coordinator@demo.campusops.local");
    const res = await get(`/clubs/${club?.id}/members`, token);
    expect(res.status).toBe(200);
    expect(res.json.data.items.length).toBeGreaterThan(0);
    expect(res.json.data.canManage).toBe(false);
  });
});
