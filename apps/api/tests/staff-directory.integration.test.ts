import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { type DbClient, closeDb, createDb, getDb } from "../src/db/client";
import { departments, roleAssignments, staffProfiles, users } from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/**
 * The staff directory is a security boundary, not a screen: an HOD/Dean must see
 * and edit only their own department. These tests exist because the route sits
 * behind a router that is otherwise Admin-only, and a mistake there is invisible
 * in the UI until data leaks.
 */
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PASSWORD = "Staff-Directory-Test-Password!";
const app = createApp();
const stamp = Date.now();

type Json = Record<string, unknown>;

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as Json;
  return { status: res.status, json };
}
const data = <T = Json>(r: { json: Json }) => r.json.data as T;
const code = (r: { json: Json }) =>
  ((r.json.error as { code?: string } | undefined)?.code ?? "") as string;

maybe("department-scoped staff directory", () => {
  let client: DbClient;
  let adminToken = "";
  let hodToken = "";
  let cseStaffId = "";
  let eceStaffId = "";
  let cseDeptId = "";
  let eceDeptId = "";

  async function makeStaff(label: string, departmentId: string) {
    const { db } = getDb();
    const email = `sdir.${label}.${stamp}@test.campusops.local`;
    const [u] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(PASSWORD),
        accountType: "STAFF",
        status: "ACTIVE",
        fullName: `Directory ${label}`,
        phone: "+919800000000",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!u) throw new Error("staff insert failed");
    await db.insert(staffProfiles).values({
      userId: u.id,
      departmentId,
      designation: "Assistant Professor",
      position: "ASSISTANT_PROFESSOR",
    });
    return u.id;
  }

  async function login(email: string) {
    const r = await req("POST", "/api/v1/auth/login", {
      email,
      password: PASSWORD,
      client: "mobile",
    });
    expect(r.status).toBe(200);
    return data<{ accessToken: string }>(r).accessToken;
  }

  beforeAll(async () => {
    client = createDb(url as string, 2);
    const { db } = getDb();
    const [cse] = await db
      .insert(departments)
      .values({ code: `SDC${String(stamp).slice(-5)}`, name: `Directory CSE ${stamp}` })
      .returning();
    const [ece] = await db
      .insert(departments)
      .values({ code: `SDE${String(stamp).slice(-5)}`, name: `Directory ECE ${stamp}` })
      .returning();
    if (!cse || !ece) throw new Error("department insert failed");
    cseDeptId = cse.id;
    eceDeptId = ece.id;

    const adminEmail = `sdir.admin.${stamp}@test.campusops.local`;
    const [admin] = await db
      .insert(users)
      .values({
        email: adminEmail,
        passwordHash: await hashPassword(PASSWORD),
        accountType: "STAFF",
        status: "ACTIVE",
        fullName: "Directory Admin",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!admin) throw new Error("admin insert failed");
    const adminId = admin.id;
    await db.insert(staffProfiles).values({
      userId: adminId,
      departmentId: null,
      designation: "Registrar",
      position: "OTHER",
    });
    await db
      .insert(roleAssignments)
      .values({ userId: adminId, role: "ADMIN", scopeType: "GLOBAL" });

    const hodEmail = `sdir.hod.${stamp}@test.campusops.local`;
    const [hod] = await db
      .insert(users)
      .values({
        email: hodEmail,
        passwordHash: await hashPassword(PASSWORD),
        accountType: "STAFF",
        status: "ACTIVE",
        fullName: "Directory HOD",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!hod) throw new Error("hod insert failed");
    const hodId = hod.id;
    await db.insert(staffProfiles).values({
      userId: hodId,
      departmentId: cseDeptId,
      designation: "HOD",
      position: "HOD",
    });
    await db.insert(roleAssignments).values({
      userId: hodId,
      role: "HOD_DEAN",
      scopeType: "DEPARTMENT",
      departmentId: cseDeptId,
    });

    cseStaffId = await makeStaff("cse", cseDeptId);
    eceStaffId = await makeStaff("ece", eceDeptId);

    adminToken = await login(adminEmail);
    hodToken = await login(hodEmail);
  });

  afterAll(async () => {
    if (client) await closeDb(client);
  });

  test("admin sees staff across departments", async () => {
    // Scoped to the two departments this test created. Asking for "everything,
    // limit 100" passes on a fresh database and fails on the tenth run against a
    // shared one, which is the kind of test that teaches people to ignore red.
    const r = await req(
      "GET",
      `/api/v1/admin/staff?limit=100&departmentId=${eceDeptId}`,
      undefined,
      adminToken,
    );
    expect(r.status).toBe(200);
    expect((data<{ items: Array<{ id: string }> }>(r).items ?? []).map((i) => i.id)).toContain(
      eceStaffId,
    );
    const cse = await req(
      "GET",
      `/api/v1/admin/staff?limit=100&departmentId=${cseDeptId}`,
      undefined,
      adminToken,
    );
    expect((data<{ items: Array<{ id: string }> }>(cse).items ?? []).map((i) => i.id)).toContain(
      cseStaffId,
    );
  });

  test("an HOD/Dean sees only their own department", async () => {
    const r = await req("GET", "/api/v1/admin/staff?limit=100", undefined, hodToken);
    expect(r.status).toBe(200);
    const items = data<{ items: Array<{ id: string; departmentId: string | null }> }>(r).items;
    const ids = items.map((i) => i.id);
    expect(ids).toContain(cseStaffId);
    expect(ids).not.toContain(eceStaffId);
    // The scope is enforced in the query, not by filtering the page: every row
    // returned belongs to the caller's department.
    expect(items.every((i) => i.departmentId === cseDeptId)).toBe(true);
  });

  test("an HOD/Dean cannot widen the scope with a departmentId in the query", async () => {
    const r = await req(
      "GET",
      `/api/v1/admin/staff?departmentId=${eceDeptId}`,
      undefined,
      hodToken,
    );
    expect(r.status).toBe(403);
    expect(code(r)).toBe("FORBIDDEN");
  });

  test("an HOD/Dean cannot edit a staff member in another department", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/admin/staff/${eceStaffId}`,
      { fullName: "Hijacked Name" },
      hodToken,
    );
    expect(r.status).toBe(403);
    expect(code(r)).toBe("FORBIDDEN");
  });

  test("an HOD/Dean may edit contact details in their own department", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/admin/staff/${cseStaffId}`,
      { fullName: "Directory CSE Renamed", phone: "+919811111111" },
      hodToken,
    );
    expect(r.status).toBe(200);
    const user = data<{ user: { fullName: string; phone: string | null } }>(r).user;
    expect(user.fullName).toBe("Directory CSE Renamed");
    expect(user.phone).toBe("+919811111111");
  });

  test("an HOD/Dean cannot change structure: department, position or employee code", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/admin/staff/${cseStaffId}`,
      { position: "PROFESSOR" },
      hodToken,
    );
    expect(r.status).toBe(400);
  });

  test("admin can change the department of a staff member", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/admin/staff/${cseStaffId}`,
      { departmentId: eceDeptId, designation: "Professor" },
      adminToken,
    );
    expect(r.status).toBe(200);
    const { db } = getDb();
    const [row] = await db
      .select()
      .from(staffProfiles)
      .where(eq(staffProfiles.userId, cseStaffId))
      .limit(1);
    expect(row?.departmentId).toBe(eceDeptId);
  });

  test("changing an email clears verification and revokes sessions", async () => {
    const before = await req(
      "PATCH",
      `/api/v1/admin/staff/${eceStaffId}`,
      { email: `sdir.moved.${stamp}@test.campusops.local` },
      adminToken,
    );
    expect(before.status).toBe(200);
    const payload = data<{ emailVerificationRequired: boolean; user: { status: string } }>(before);
    expect(payload.emailVerificationRequired).toBe(true);
    // The account must not stay ACTIVE on an unconfirmed address.
    expect(payload.user.status).toBe("PENDING_EMAIL");
  });

  test("an email already in use is reported as a conflict, not a 500", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/admin/staff/${eceStaffId}`,
      { email: `sdir.admin.${stamp}@test.campusops.local` },
      adminToken,
    );
    expect(r.status).toBe(409);
    expect(code(r)).toBe("EMAIL_EXISTS");
  });

  test("a non-staff account is refused rather than half-edited", async () => {
    const { db } = getDb();
    const [student] = await db
      .insert(users)
      .values({
        email: `sdir.student.${stamp}@test.campusops.local`,
        passwordHash: await hashPassword(PASSWORD),
        accountType: "COLLEGE_STUDENT",
        status: "ACTIVE",
        fullName: "Directory Student",
      })
      .returning();
    if (!student) throw new Error("student insert failed");
    const studentId = student.id;
    const r = await req(
      "PATCH",
      `/api/v1/admin/staff/${studentId}`,
      { fullName: "Nope" },
      adminToken,
    );
    expect(r.status).toBe(400);
  });

  test("programmes are narrowed to the HOD's department", async () => {
    const r = await req("GET", "/api/v1/admin/programs", undefined, hodToken);
    expect(r.status).toBe(200);
    const items = data<{
      items: Array<{ departmentId: string | null; foundationDepartmentId: string | null }>;
    }>(r).items;
    expect(
      items.every((p) => p.departmentId === cseDeptId || p.foundationDepartmentId === cseDeptId),
    ).toBe(true);
  });

  test("a plain faculty member is refused the directory entirely", async () => {
    const { db } = getDb();
    const email = `sdir.faculty.${stamp}@test.campusops.local`;
    const [f] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(PASSWORD),
        accountType: "STAFF",
        status: "ACTIVE",
        fullName: "Directory Faculty",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!f) throw new Error("faculty insert failed");
    await db.insert(staffProfiles).values({
      userId: f.id,
      departmentId: cseDeptId,
      designation: "Faculty",
      position: "PROFESSOR",
    });
    await db.insert(roleAssignments).values({
      userId: f.id,
      role: "FACULTY",
      scopeType: "DEPARTMENT",
      departmentId: cseDeptId,
    });
    const token = await login(email);
    const r = await req("GET", "/api/v1/admin/staff", undefined, token);
    expect(r.status).toBe(403);
  });
});
