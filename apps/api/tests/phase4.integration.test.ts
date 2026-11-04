import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  clubMemberships,
  clubs,
  departments,
  roleAssignments,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/**
 * Phase 4 added three management endpoints the website depends on:
 *   GET/POST/PATCH /departments
 *   GET /admin/users/:id
 *   GET /clubs/:id/candidates
 * These tests pin their behaviour and, more importantly, their authorization,
 * because each one is reachable from a form that several roles can open.
 */
const app = createApp();
const PASSWORD = "Phase4-Test-Password!";
const stamp = Date.now();
const rnd = () => Math.random().toString(36).slice(2, 8);

// biome-ignore lint/suspicious/noExplicitAny: dynamic API response bodies in tests
type Body = Record<string, any>;

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

async function login(email: string) {
  const r = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  expect(r.status).toBe(200);
  return r.json.data.accessToken as string;
}

async function staff(label: string, role?: "ADMIN" | "FACULTY" | "HOD_DEAN", dept?: string) {
  const { db } = getDb();
  const email = `p4.${label}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: "STAFF",
      status: "ACTIVE",
      fullName: `Phase4 ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!u) throw new Error("insert failed");
  await db.insert(staffProfiles).values({
    userId: u.id,
    departmentId: dept ?? null,
    designation: label,
  });
  if (role) {
    await db.insert(roleAssignments).values({
      userId: u.id,
      role,
      scopeType: role === "ADMIN" ? "GLOBAL" : "DEPARTMENT",
      departmentId: role === "ADMIN" ? null : (dept ?? null),
    });
  }
  ids[label] = u.id;
  tokens[label] = await login(email);
  return u.id;
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `P4${stamp}`.slice(0, 20), name: "Phase 4 Dept" })
    .returning();
  if (!dept) throw new Error("dept failed");
  ids.dept = dept.id;

  await staff("admin", "ADMIN");
  await staff("senior", "HOD_DEAN", dept.id);
  await staff("faculty", "FACULTY", dept.id);
  await staff("plain");

  const [club] = await db
    .insert(clubs)
    .values({
      name: `Phase 4 Club ${stamp}`,
      slug: `p4-club-${stamp}-${rnd()}`,
      departmentId: dept.id,
    })
    .returning();
  if (!club) throw new Error("club failed");
  ids.club = club.id;

  // A club lead (not staff) who may manage the club.
  const leadEmail = `p4.lead.${stamp}.${rnd()}@test.campusops.local`;
  const [lead] = await db
    .insert(users)
    .values({
      email: leadEmail,
      passwordHash: await hashPassword(PASSWORD),
      accountType: "COLLEGE_STUDENT",
      status: "ACTIVE",
      fullName: "Phase4 Lead",
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!lead) throw new Error("lead failed");
  await db.insert(studentProfiles).values({
    userId: lead.id,
    studentKind: "COLLEGE_STUDENT",
    institutionName: "CampusOps Test Institute",
    collegeIdNumber: `P4L${stamp}`.slice(0, 30),
    departmentId: dept.id,
    graduationYear: 2027,
    verifiedAt: new Date(),
    verifiedBy: ids.faculty,
  });
  await db.insert(clubMemberships).values([
    { clubId: club.id, userId: lead.id, clubRole: "LEAD" },
    { clubId: club.id, userId: ids.faculty as string, clubRole: "FACULTY" },
  ]);
  ids.lead = lead.id;
  tokens.lead = await login(leadEmail);

  // A searchable active college student, an outsider and a suspended account.
  for (const [label, accountType, status] of [
    ["candidate", "COLLEGE_STUDENT", "ACTIVE"],
    ["outsider", "OUTSIDER_STUDENT", "ACTIVE"],
    ["suspended", "COLLEGE_STUDENT", "SUSPENDED"],
  ] as const) {
    const email = `p4.${label}.${stamp}.${rnd()}@test.campusops.local`;
    const [u] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(PASSWORD),
        accountType,
        status,
        fullName: `Zsearch${stamp} ${label}`,
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!u) throw new Error("candidate insert failed");
    ids[label] = u.id;
  }
});

describe("departments directory", () => {
  test("requires authentication", async () => {
    const r = await req("GET", "/api/v1/departments");
    expect(r.status).toBe(401);
  });

  test("any active account can read the list, including accounts with no role", async () => {
    const r = await req("GET", "/api/v1/departments", undefined, tokens.plain);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.data.items)).toBe(true);
    const found = r.json.data.items.find((d: Body) => d.id === ids.dept);
    expect(found.name).toBe("Phase 4 Dept");
    // The directory is a picker source: it must not leak staff or student data.
    expect(Object.keys(found).sort()).toEqual(["code", "id", "name"]);
  });

  test("admin creates a department and the code is normalised to upper case", async () => {
    const code = `p4-n-${rnd()}`;
    const r = await req(
      "POST",
      "/api/v1/departments",
      { code, name: "New Teaching Dept" },
      tokens.admin,
    );
    expect(r.status).toBe(201);
    expect(r.json.data.code).toBe(code.toUpperCase());
    ids.created = r.json.data.id;
  });

  test("a duplicate code is a conflict, not a silent second row", async () => {
    const r = await req(
      "POST",
      "/api/v1/departments",
      { code: `P4${stamp}`.slice(0, 20), name: "Duplicate" },
      tokens.admin,
    );
    expect(r.status).toBe(409);
  });

  test("an invalid code is rejected by validation", async () => {
    const r = await req(
      "POST",
      "/api/v1/departments",
      { code: "bad code!", name: "Bad" },
      tokens.admin,
    );
    expect(r.status).toBe(400);
  });

  test("HOD/Dean cannot create departments: structure is an admin power", async () => {
    const r = await req(
      "POST",
      "/api/v1/departments",
      { code: `p4x${rnd()}`, name: "Should not exist" },
      tokens.senior,
    );
    expect(r.status).toBe(403);
  });

  test("faculty cannot create departments", async () => {
    const r = await req(
      "POST",
      "/api/v1/departments",
      { code: `p4y${rnd()}`, name: "Should not exist" },
      tokens.faculty,
    );
    expect(r.status).toBe(403);
  });

  test("admin renames a department", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/departments/${ids.created}`,
      { name: "Renamed Dept" },
      tokens.admin,
    );
    expect(r.status).toBe(200);
    expect(r.json.data.name).toBe("Renamed Dept");
  });

  test("HOD/Dean cannot rename departments", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/departments/${ids.created}`,
      { name: "Nope" },
      tokens.senior,
    );
    expect(r.status).toBe(403);
  });

  test("an empty update is refused rather than writing a no-op audit row", async () => {
    const r = await req("PATCH", `/api/v1/departments/${ids.created}`, {}, tokens.admin);
    expect(r.status).toBe(400);
  });

  test("renaming an unknown department is a 404", async () => {
    const r = await req(
      "PATCH",
      `/api/v1/departments/${crypto.randomUUID()}`,
      { name: "Ghost" },
      tokens.admin,
    );
    expect(r.status).toBe(404);
  });
});

describe("admin user detail", () => {
  test("returns the roles and memberships the revoke UI needs", async () => {
    const r = await req("GET", `/api/v1/admin/users/${ids.lead}`, undefined, tokens.admin);
    expect(r.status).toBe(200);
    expect(r.json.data.user.id).toBe(ids.lead);
    expect(r.json.data.studentProfile.collegeIdNumber).toContain("P4L");
    expect(Array.isArray(r.json.data.roles)).toBe(true);
    const membership = r.json.data.clubMemberships.find((m: Body) => m.clubId === ids.club);
    expect(membership.clubRole).toBe("LEAD");
    expect(membership.clubName).toContain("Phase 4 Club");
    // A password hash must never travel to the browser.
    expect(r.json.data.user.passwordHash).toBeUndefined();
  });

  test("exposes a staff profile and assigned roles for staff", async () => {
    const r = await req("GET", `/api/v1/admin/users/${ids.senior}`, undefined, tokens.admin);
    expect(r.status).toBe(200);
    expect(r.json.data.staffProfile.designation).toBe("senior");
    expect(r.json.data.roles.some((x: Body) => (x.role ?? x) === "HOD_DEAN")).toBe(true);
  });

  test("HOD/Dean cannot read arbitrary user detail", async () => {
    const r = await req("GET", `/api/v1/admin/users/${ids.lead}`, undefined, tokens.senior);
    expect(r.status).toBe(403);
  });

  test("an unknown user is a 404", async () => {
    const r = await req(
      "GET",
      `/api/v1/admin/users/${crypto.randomUUID()}`,
      undefined,
      tokens.admin,
    );
    expect(r.status).toBe(404);
  });
});

describe("club member candidate search", () => {
  test("a club lead can search and finds an active college student", async () => {
    const r = await req(
      "GET",
      `/api/v1/clubs/${ids.club}/candidates?q=Zsearch${stamp}&limit=25`,
      undefined,
      tokens.lead,
    );
    expect(r.status).toBe(200);
    const found = r.json.data.items.find((x: Body) => x.id === ids.candidate);
    expect(found.fullName).toContain("candidate");
    expect(Object.keys(found).sort()).toEqual(["accountType", "email", "fullName", "id"]);
  });

  test("outsiders and non-active accounts are never offered as members", async () => {
    const r = await req(
      "GET",
      `/api/v1/clubs/${ids.club}/candidates?q=Zsearch${stamp}&limit=25`,
      undefined,
      tokens.lead,
    );
    const returned = r.json.data.items.map((x: Body) => x.id);
    expect(returned).not.toContain(ids.outsider);
    expect(returned).not.toContain(ids.suspended);
  });

  test("club faculty help run events but do not manage the club team", async () => {
    // There is no advisor role any more. Faculty organise and scan; adding and
    // removing people stays with the lead (coordinators) and HOD/Dean (faculty).
    const r = await req(
      "GET",
      `/api/v1/clubs/${ids.club}/candidates?q=Zsearch${stamp}`,
      undefined,
      tokens.faculty,
    );
    expect(r.status).toBe(403);
  });

  test("admin may search any club", async () => {
    const r = await req(
      "GET",
      `/api/v1/clubs/${ids.club}/candidates?q=Zsearch${stamp}`,
      undefined,
      tokens.admin,
    );
    expect(r.status).toBe(200);
  });

  test("an unrelated account cannot enumerate the student body", async () => {
    const r = await req(
      "GET",
      `/api/v1/clubs/${ids.club}/candidates?q=Zsearch${stamp}`,
      undefined,
      tokens.plain,
    );
    expect(r.status).toBe(403);
  });

  test("a one-character query is refused so the directory cannot be scraped cheaply", async () => {
    const r = await req("GET", `/api/v1/clubs/${ids.club}/candidates?q=a`, undefined, tokens.lead);
    expect(r.status).toBe(400);
  });

  test("the limit is capped", async () => {
    const r = await req(
      "GET",
      `/api/v1/clubs/${ids.club}/candidates?q=Zsearch${stamp}&limit=500`,
      undefined,
      tokens.lead,
    );
    expect(r.status).toBe(400);
  });

  test("an unknown club is a 404", async () => {
    const r = await req(
      "GET",
      `/api/v1/clubs/${crypto.randomUUID()}/candidates?q=abc`,
      undefined,
      tokens.admin,
    );
    expect(r.status).toBe(404);
  });
});
