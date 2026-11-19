import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  clubMemberships,
  clubs,
  departments,
  eventInvitations,
  passes,
  registrationHistory,
  registrations,
  roleAssignments,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

const app = createApp();
const PASSWORD = "Registration-Test-Password!";
const stamp = Date.now();
const rnd = () => Math.random().toString(36).slice(2, 8);
// biome-ignore lint/suspicious/noExplicitAny: dynamic response bodies
type Body = Record<string, any>;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
async function req(method: string, path: string, body?: unknown, who?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}
async function account(
  label: string,
  kind: "COLLEGE_STUDENT" | "OUTSIDER_STUDENT" | "STAFF" = "COLLEGE_STUDENT",
  dept = "dept",
) {
  const { db } = getDb();
  const email = `reg.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: kind,
      status: "ACTIVE",
      fullName: `Registration ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!u) throw new Error("user");
  ids[label] = u.id;
  if (kind === "STAFF") {
    await db
      .insert(staffProfiles)
      .values({ userId: u.id, departmentId: ids[dept] as string, designation: "Lead" });
    await db.insert(roleAssignments).values({ userId: u.id, role: "ADMIN", scopeType: "GLOBAL" });
  } else
    await db.insert(studentProfiles).values({
      userId: u.id,
      studentKind: kind,
      institutionName: "Test College",
      departmentId: kind === "COLLEGE_STUDENT" ? (ids[dept] as string) : null,
      graduationYear: 2027,
      rollNumber: `RG${stamp}${rnd()}`.slice(0, 20),
      collegeIdNumber: `ID-${rnd()}`,
    });
  const login = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  tokens[label] = login.json.data.accessToken;
}
async function event(label: string, over: Body = {}) {
  const { db } = getDb();
  const [e] = await db
    .insert(events)
    .values({
      clubId: ids.club as string,
      createdBy: ids.lead as string,
      title: `${label} ${stamp}`,
      slug: `${label}-${stamp}-${rnd()}`,
      description: "Registration test event.",
      template: "CUSTOM",
      audience: "COLLEGE_ONLY",
      admissionMode: "FCFS",
      capacity: 2,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
      registrationOpensAt: new Date(Date.now() - 86_400_000),
      registrationClosesAt: new Date(Date.now() + 3_600_000),
      status: "PUBLISHED",
      publishedAt: new Date(),
      ...over,
    })
    .returning();
  if (!e) throw new Error("event");
  ids[label] = e.id;
  return e.id;
}
const register = (id: string, who: string) => req("POST", `/api/v1/events/${id}/register`, {}, who);

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `RG${stamp}`.slice(0, 20), name: "Registration Dept" })
    .returning();
  const [other] = await db
    .insert(departments)
    .values({ code: `RX${stamp}`.slice(0, 20), name: "Other Dept" })
    .returning();
  ids.dept = dept?.id as string;
  ids.other = other?.id as string;
  for (const label of ["lead", "a", "b", "c", "outsider", "otherDept"])
    await account(
      label,
      label === "lead" ? "STAFF" : label === "outsider" ? "OUTSIDER_STUDENT" : "COLLEGE_STUDENT",
      label === "otherDept" ? "other" : "dept",
    );
  const [club] = await db
    .insert(clubs)
    .values({
      name: `Registration Club ${stamp}`,
      slug: `reg-club-${stamp}`,
      departmentId: ids.dept as string,
      createdBy: ids.lead as string,
    })
    .returning();
  ids.club = club?.id as string;
  await db
    .insert(clubMemberships)
    .values({ clubId: ids.club as string, userId: ids.lead as string, clubRole: "LEAD" });
  await event("fcfs", { capacity: 1 });
  await event("manual", { admissionMode: "MANUAL" });
  await event("public", { audience: "OUTSIDERS_ALLOWED" });
  await event("invited", { audience: "INVITED_ONLY" });
  await event("restricted", {
    eligibilityPolicy: {
      version: 1,
      accountTypes: ["COLLEGE_STUDENT"],
      departmentIds: [ids.dept],
      graduationYears: [2027],
      requireInvitation: false,
    },
  });
  await event("closed", {
    registrationClosesAt: new Date(Date.now() - 1000),
    startsAt: new Date(Date.now() + 1000),
    endsAt: new Date(Date.now() + 3_600_000),
  });
  await event("draft", { status: "DRAFT", publishedAt: null });
  await event("quiz", { admissionMode: "QUIZ_TOP_N" });
});

describe("participant registration", () => {
  test("public department choices are available before sign-in", async () => {
    const res = await req("GET", "/api/v1/auth/departments");
    expect(res.status).toBe(200);
    expect(res.json.data.items.some((d: Body) => d.id === ids.dept)).toBe(true);
    expect(res.json.data.items[0].passwordHash).toBeUndefined();
  });
  test("FCFS confirms the first participant and issues a pass in the same transaction", async () => {
    const res = await register(ids.fcfs as string, "a");
    expect(res.status).toBe(201);
    expect(res.json.data.registration.status).toBe("CONFIRMED");
    expect(res.json.data.passId).toBeTruthy();
    const { db } = getDb();
    const [pass] = await db
      .select()
      .from(passes)
      .where(eq(passes.registrationId, res.json.data.registration.id));
    expect(pass?.id).toBe(res.json.data.passId);
    const history = await db
      .select()
      .from(registrationHistory)
      .where(eq(registrationHistory.registrationId, res.json.data.registration.id));
    expect(history[0]?.toStatus).toBe("CONFIRMED");
  });
  test("the next participant is waitlisted, not over capacity", async () => {
    const res = await register(ids.fcfs as string, "b");
    expect(res.status).toBe(201);
    expect(res.json.data.registration.status).toBe("WAITLISTED");
    expect(res.json.data.registration.queuePosition).toBe(1);
    expect(res.json.data.passId).toBeNull();
  });
  test("repeating registration is safe and creates no second row", async () => {
    const again = await register(ids.fcfs as string, "a");
    expect(again.status).toBe(200);
    expect(again.json.data.alreadyRegistered).toBe(true);
    const { db } = getDb();
    const rows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, ids.fcfs as string));
    expect(rows).toHaveLength(2);
  });
  test("parallel requests for the last seat cannot both confirm", async () => {
    const id = await event("race", { capacity: 1 });
    const results = await Promise.all([register(id, "a"), register(id, "b")]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results.map((r) => r.json.data.registration.status).sort()).toEqual([
      "CONFIRMED",
      "WAITLISTED",
    ]);
  });
  test("manual selection creates an application without a pass", async () => {
    const res = await register(ids.manual as string, "a");
    expect(res.json.data.registration.status).toBe("APPLIED");
    expect(res.json.data.passId).toBeNull();
  });
  test("college-only events refuse outsiders", async () => {
    // Invisible events stay invisible: the audience filter returns 404 before
    // registration can reveal that a college-only event exists.
    const res = await register(ids.fcfs as string, "outsider");
    expect(res.status).toBe(404);
  });
  test("outsiders can register for public events, and arrive as applications", () => {
    // An outsider has no department and no batch, so the campus rules cannot judge
    // them — they are never auto-confirmed and never silently refused. The
    // organiser decides, and a pass is issued only after that decision.
    return register(ids.public as string, "outsider").then((res) => {
      expect(res.json.data.registration.status).toBe("APPLIED");
      expect(res.json.data.passId).toBeNull();
    });
  });
  test("invited-only events require a live invitation", async () => {
    expect((await register(ids.invited as string, "a")).status).toBe(404);
    const { db } = getDb();
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.id, ids.a as string));
    await db.insert(eventInvitations).values({
      eventId: ids.invited as string,
      email: u?.email as string,
      invitedBy: ids.lead as string,
    });
    expect((await register(ids.invited as string, "a")).status).toBe(201);
  });
  test("eligibility is enforced server-side with readable reasons", async () => {
    const res = await register(ids.restricted as string, "otherDept");
    expect(res.status).toBe(422);
    expect(res.json.error.details.reasons).toContain("DEPARTMENT_NOT_ALLOWED");
    expect(res.json.error.details.messages[0]).toContain("departments");
    expect((await register(ids.restricted as string, "a")).status).toBe(201);
  });
  test("closed registration and invisible drafts are refused", async () => {
    expect((await register(ids.closed as string, "a")).json.error.code).toBe("EVENT_NOT_OPEN");
    expect((await register(ids.draft as string, "a")).status).toBe(404);
  });
  test("quiz admission records interest without granting a seat or a pass", async () => {
    const res = await register(ids.quiz as string, "a");
    expect(res.status).toBe(201);
    // Registering is allowed, but the seat must still be earned in the quiz.
    expect(res.json.data.registration.status).toBe("APPLIED");
    expect(res.json.data.passId ?? null).toBeNull();
  });
  test("staff cannot register as participants", async () => {
    expect((await register(ids.public as string, "lead")).status).toBe(403);
  });
  test("the participant view exposes eligibility and seat count, not other people's registrations", async () => {
    const res = await req("GET", `/api/v1/events/${ids.fcfs}/participant`, undefined, "a");
    expect(res.status).toBe(200);
    expect(res.json.data.seatsRemaining).toBe(0);
    expect(res.json.data.registration.status).toBe("CONFIRMED");
    expect(res.json.data.eligibility.canApply).toBe(true);
    expect(JSON.stringify(res.json.data)).not.toContain("Registration a");
  });
  test("my registrations contains only the caller's rows", async () => {
    const a = await req("GET", "/api/v1/me/registrations", undefined, "a");
    const b = await req("GET", "/api/v1/me/registrations", undefined, "b");
    expect(a.json.data.items.length).toBeGreaterThan(1);
    expect(b.json.data.items.filter((r: Body) => r.eventId === ids.fcfs)).toHaveLength(1);
    expect(a.json.data.items.every((r: Body) => r.userId === ids.a)).toBe(true);
    expect(b.json.data.items[0].event.title).toBeTruthy();
  });
  test("the wallet receives the automatically issued pass and coordinator QRs", async () => {
    const created = await req(
      "POST",
      `/api/v1/events/${ids.fcfs}/checkpoints`,
      { name: "abc", qrType: "TOGGLE", validityMode: "MANUAL" },
      "lead",
    );
    expect(created.status).toBe(201);
    const wallet = await req("GET", "/api/v1/me/passes", undefined, "a");
    const pass = wallet.json.data.items.find((p: Body) => p.event.id === ids.fcfs);
    expect(pass.checkpoints[0].name).toBe("abc");
    expect(pass.checkpoints[0].nextDirection).toBe("IN");
  });
});
