import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import { studentProfiles, users } from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/**
 * Programmes own their department mapping, and a programme may define a
 * foundation window (first N years in another department). Registration stores
 * the resolved membership, and changing the mapping re-places current students.
 */
const app = createApp();
// biome-ignore lint/suspicious/noExplicitAny: dynamic API response bodies in tests
type Body = Record<string, any>;
const PW = "Programs-Test-Password!";
const stamp = Date.now().toString().slice(-7);

beforeAll(async () => {
  const { db } = getDb();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(PW) })
    .where(inArray(users.email, ["principal@demo.campusops.local"]));
});

async function login(email = "principal@demo.campusops.local") {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PW, client: "mobile" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Body).data.accessToken as string;
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

async function department(token: string, code: string, name: string) {
  const res = await call("POST", "/departments", token, { code, name });
  expect(res.status).toBe(201);
  return res.json.data.id as string;
}

async function program(token: string, input: Record<string, unknown>) {
  const res = await call("POST", "/departments/programs", token, input);
  return res;
}

async function register(input: Record<string, unknown>) {
  const res = await app.request("/api/v1/auth/register/college", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: PW,
      fullName: "Programme Placement Test",
      institutionName: "Programmes Test College",
      client: "mobile",
      ...input,
    }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

async function storedDepartment(email: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ departmentId: studentProfiles.departmentId, studyYear: studentProfiles.studyYear })
    .from(studentProfiles)
    .innerJoin(users, eq(users.id, studentProfiles.userId))
    .where(eq(users.email, email))
    .limit(1);
  return row;
}

describe("programme department mapping", () => {
  test("foundation years resolve per student and follow config changes", async () => {
    const token = await login();
    const science = await department(token, `S${stamp}`, "Applied Science Test");
    const computing = await department(token, `C${stamp}`, "Computing Test");
    const created = await program(token, {
      name: `B.Tech Placement ${stamp}`,
      departmentId: computing,
      foundationDepartmentId: science,
      foundationYears: 1,
      durationYears: 4,
    });
    expect(created.status).toBe(201);
    const programId = created.json.data.id as string;

    const noYear = await register({
      email: `programme-noyear-${stamp}@example.test`,
      rollNumber: `PN-${stamp}`,
      programId,
    });
    expect(noYear.status).toBe(400);

    const firstYear = `programme-first-${stamp}@example.test`;
    const thirdYear = `programme-third-${stamp}@example.test`;
    const firstSignup = await register({
      email: firstYear,
      rollNumber: `PF-${stamp}`,
      programId,
      studyYear: 1,
    });
    expect(firstSignup.status).toBe(201);
    expect(
      (
        await register({
          email: thirdYear,
          rollNumber: `PT-${stamp}`,
          programId,
          studyYear: 3,
        })
      ).status,
    ).toBe(201);

    expect(await storedDepartment(firstYear)).toEqual({
      departmentId: science,
      studyYear: 1,
    });
    expect(await storedDepartment(thirdYear)).toEqual({
      departmentId: computing,
      studyYear: 3,
    });

    // Staff can move a student to the next year; membership follows the rule.
    const promoted = await call(
      "PATCH",
      `/faculty/students/${firstSignup.json.data.user.id}/profile`,
      token,
      { programId, studyYear: 2 },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.json.data.profile.departmentId).toBe(computing);

    // Changing the foundation window re-places enrolled students by their year.
    const updated = await call("PATCH", `/departments/programs/${programId}`, token, {
      foundationYears: 3,
    });
    expect(updated.status).toBe(200);
    expect((await storedDepartment(firstYear))?.departmentId).toBe(science);
    expect((await storedDepartment(firstYear))?.studyYear).toBe(2);
    expect((await storedDepartment(thirdYear))?.departmentId).toBe(science);
  });

  test("registration validates the programme and its duration", async () => {
    const token = await login();
    const home = await department(token, `D${stamp}`, "Home Department Test");
    const created = await program(token, {
      name: `BBA Placement ${stamp}`,
      departmentId: home,
      durationYears: 3,
    });
    expect(created.status).toBe(201);
    const programId = created.json.data.id as string;

    const beyond = await register({
      email: `programme-beyond-${stamp}@example.test`,
      rollNumber: `PB-${stamp}`,
      programId,
      studyYear: 6,
    });
    expect(beyond.status).toBe(400);

    const missing = await register({
      email: `programme-missing-${stamp}@example.test`,
      rollNumber: `PM-${stamp}`,
      programId: "00000000-0000-4000-8000-000000000000",
      studyYear: 1,
    });
    expect(missing.status).toBe(400);
  });

  test("a programme cannot create a longer foundation than its duration", async () => {
    const token = await login();
    const home = await department(token, `E${stamp}`, "Duration Department Test");
    const created = await program(token, {
      name: `Short Placement ${stamp}`,
      departmentId: home,
      foundationYears: 5,
      durationYears: 3,
    });
    expect(created.status).toBe(400);
  });
});
