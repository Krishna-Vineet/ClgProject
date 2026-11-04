import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  clubMemberships,
  clubs,
  departments,
  roleAssignments,
  staffProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

const app = createApp();
// biome-ignore lint/suspicious/noExplicitAny: dynamic API response bodies in tests
type Body = Record<string, any>;
const PASSWORD = "Search-Test-Password!";
const stamp = `${Date.now()}`.slice(-9);
const prefix = `srch${stamp}`;

const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

async function request(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

async function makeUser(
  label: string,
  accountType: "STAFF" | "COLLEGE_STUDENT" | "OUTSIDER_STUDENT",
  role?: { role: "ADMIN" | "HOD_DEAN" | "FACULTY"; departmentId: string | null },
) {
  const { db } = getDb();
  const email = `${prefix}.${label}@test.campusops.local`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType,
      status: "ACTIVE",
      fullName: `${prefix} ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("user insert failed");
  ids[label] = user.id;
  if (role) {
    await db.insert(roleAssignments).values({
      userId: user.id,
      role: role.role,
      scopeType: role.departmentId ? "DEPARTMENT" : "GLOBAL",
      departmentId: role.departmentId,
    });
    if (accountType === "STAFF")
      await db.insert(staffProfiles).values({
        userId: user.id,
        departmentId: role.departmentId,
        designation: "Professor",
      });
  }
  const login = await request("POST", "/auth/login", undefined, {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  expect(login.status).toBe(200);
  tokens[label] = login.json.data.accessToken as string;
  return user.id;
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `SRCH${stamp}`.slice(0, 20), name: `${prefix} Department` })
    .returning();
  const [otherDept] = await db
    .insert(departments)
    .values({ code: `SRCX${stamp}`.slice(0, 20), name: `${prefix} Other Department` })
    .returning();
  if (!dept || !otherDept) throw new Error("department insert failed");
  ids.dept = dept.id;

  const adminId = await makeUser("admin", "STAFF", { role: "ADMIN", departmentId: null });
  await makeUser("hod", "STAFF", { role: "HOD_DEAN", departmentId: dept.id });
  await makeUser("otherhod", "STAFF", { role: "HOD_DEAN", departmentId: otherDept.id });
  const facultyId = await makeUser("faculty", "STAFF", {
    role: "FACULTY",
    departmentId: dept.id,
  });
  const leadId = await makeUser("lead", "COLLEGE_STUDENT");
  await makeUser("outsider", "OUTSIDER_STUDENT");

  const [club] = await db
    .insert(clubs)
    .values({
      name: `${prefix} Club`,
      slug: `${prefix}-club`,
      departmentId: dept.id,
      createdBy: adminId,
    })
    .returning();
  const [otherClub] = await db
    .insert(clubs)
    .values({
      name: `${prefix} Other Club`,
      slug: `${prefix}-other-club`,
      departmentId: otherDept.id,
      createdBy: adminId,
    })
    .returning();
  if (!club || !otherClub) throw new Error("club insert failed");
  ids.club = club.id;
  await db.insert(clubMemberships).values({ clubId: club.id, userId: leadId, clubRole: "LEAD" });
  await db.insert(clubMemberships).values({
    clubId: otherClub.id,
    userId: facultyId,
    clubRole: "FACULTY",
  });

  const startsAt = new Date(Date.now() + 7 * 86_400_000);
  startsAt.setHours(10, 0, 0, 0);
  const endsAt = new Date(startsAt);
  endsAt.setHours(13, 0, 0, 0);
  const draft = await request("POST", "/events", tokens.lead, {
    clubId: club.id,
    title: `${prefix} Draft Workshop`,
    description: "A draft the search box must still find.",
    template: "WORKSHOP",
    audience: "COLLEGE_ONLY",
    admissionMode: "FCFS",
    capacity: 30,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
    registrationClosesAt: startsAt.toISOString(),
    venueSummary: "Seminar room",
  });
  expect(draft.status).toBe(201);
  expect(draft.json.data.status).toBe("DRAFT");
  ids.draft = draft.json.data.id;

  const publicStart = new Date(startsAt);
  publicStart.setDate(publicStart.getDate() + 1);
  const publicEnd = new Date(publicStart);
  publicEnd.setHours(12, 0, 0, 0);
  const [publicEvent] = await db
    .insert(events)
    .values({
      clubId: otherClub.id,
      createdBy: adminId,
      title: `${prefix} Public Showcase`,
      slug: `${prefix}-public-showcase`,
      status: "PUBLISHED",
      audience: "COLLEGE_ONLY",
      capacity: 50,
      startsAt: publicStart,
      endsAt: publicEnd,
      registrationOpensAt: new Date(Date.now() - 86_400_000),
      registrationClosesAt: publicStart,
      publishedAt: new Date(),
    })
    .returning();
  if (!publicEvent) throw new Error("public event insert failed");
  ids.publicEvent = publicEvent.id;
});

describe("global search identity", () => {
  test("people carry the console role, not the raw account type", async () => {
    const res = await request("GET", `/search?q=${prefix}&limit=20`, tokens.admin);
    expect(res.status).toBe(200);
    const people = res.json.data.people as Array<{
      fullName: string;
      role: string;
      roles: string[];
    }>;
    const roleFor = (label: string) =>
      people.find((p) => p.fullName === `${prefix} ${label}`)?.role;

    expect(roleFor("admin")).toBe("Admin");
    expect(roleFor("hod")).toBe("HOD");
    expect(roleFor("faculty")).toBe("Faculty");
    expect(roleFor("lead")).toBe("Coordinator");
    expect(roleFor("outsider")).toBe("Outsider");
    const lead = people.find((p) => p.fullName === `${prefix} lead`);
    expect(lead?.roles).toEqual(["Coordinator", "Student"]);
  });

  test("non-admins still cannot enumerate people", async () => {
    const res = await request("GET", `/search?q=${prefix}`, tokens.hod);
    expect(res.status).toBe(200);
    expect(res.json.data.people).toEqual([]);
  });
});

describe("global search event scope", () => {
  test("admin finds drafts everywhere", async () => {
    const res = await request("GET", `/search?q=${prefix}%20Draft`, tokens.admin);
    expect(res.status).toBe(200);
    expect(res.json.data.events.map((e: Body) => e.id)).toContain(ids.draft);
  });

  test("the department HOD and the club lead find the draft", async () => {
    for (const label of ["hod", "lead"]) {
      const res = await request("GET", `/search?q=${prefix}%20Draft`, tokens[label]);
      expect(res.status).toBe(200);
      expect(res.json.data.events.map((e: Body) => e.id)).toContain(ids.draft);
    }
  });

  test("another department's HOD and an unrelated faculty member do not", async () => {
    for (const label of ["otherhod", "faculty"]) {
      const res = await request("GET", `/search?q=${prefix}%20Draft`, tokens[label]);
      expect(res.status).toBe(200);
      expect(res.json.data.events.map((e: Body) => e.id)).not.toContain(ids.draft);
    }
  });

  test("published events outside the club stay discoverable", async () => {
    const res = await request("GET", "/search?q=Showcase", tokens.lead);
    expect(res.status).toBe(200);
    expect(res.json.data.events.map((e: Body) => e.id)).toContain(ids.publicEvent);
  });
});
