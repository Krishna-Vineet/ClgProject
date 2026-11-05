import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { type DbClient, closeDb, createDb, getDb } from "../src/db/client";
import { events, eventInvitations, users } from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PASSWORD = "Phase2-Test-Password!";
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
  return { status: res.status, json, headers: res.headers };
}
function data<T = Json>(r: { json: Json }): T {
  return r.json.data as T;
}
function errorCode(r: { json: Json }): string {
  return (r.json.error as { code?: string } | undefined)?.code ?? "";
}
async function login(email: string) {
  const r = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  expect(r.status).toBe(200);
  return data<{ accessToken: string; refreshToken: string; user: { id: string; status: string } }>(
    r,
  );
}

maybe("phase 2 auth and permissions", () => {
  let client: DbClient;
  let adminToken = "";
  let facultyToken = "";
  let seniorToken = "";
  let codingLeadToken = "";
  let roboticsToken = "";
  let collegeId = "";
  let collegeToken = "";
  let collegeRefresh = "";
  let outsiderToken = "";
  const collegeEmail = `phase2.college.${stamp}@test.campusops.local`;
  const outsiderEmail = `phase2.outsider.${stamp}@test.campusops.local`;
  const invitedEmail = `phase2.invited.${stamp}@test.campusops.local`;
  const staffEmail = `phase2.staff.${stamp}@test.campusops.local`;
  const invitedEventId = U(980);
  // Its own college-only event instead of the demo seed row: other suites and
  // manual probes edit that row (a venue edit even re-drafts it), which used to
  // fail this file for reasons that had nothing to do with auth.
  const collegeEventId = U(981);
  const collegeEventTitle = `Phase 2 College Only ${stamp}`;

  beforeAll(async () => {
    client = createDb(url as string, 4);
    process.env.DATABASE_URL = url;
    const hash = await hashPassword(PASSWORD);
    for (const id of [U(10), U(11), U(12), U(14), U(15), U(16), U(18)]) {
      await client.db.update(users).set({ passwordHash: hash }).where(eq(users.id, id));
    }
    await client.db
      .insert(events)
      .values({
        id: invitedEventId,
        clubId: U(40),
        createdBy: U(14),
        title: "Phase 2 Invited Only Test",
        slug: `phase2-invited-${stamp}`,
        template: "SEMINAR",
        status: "PUBLISHED",
        audience: "INVITED_ONLY",
        admissionMode: "MANUAL",
        capacity: 10,
        startsAt: new Date(Date.now() + 86400000),
        endsAt: new Date(Date.now() + 90000000),
        registrationOpensAt: new Date(),
        registrationClosesAt: new Date(Date.now() + 80000000),
        venueSummary: "Test Hall",
        publishedAt: new Date(),
      })
      .onConflictDoNothing();
    await client.db
      .insert(events)
      .values({
        id: collegeEventId,
        clubId: U(40),
        createdBy: U(14),
        title: collegeEventTitle,
        slug: `phase2-college-${stamp}`,
        template: "WORKSHOP",
        status: "PUBLISHED",
        audience: "COLLEGE_ONLY",
        admissionMode: "FCFS",
        capacity: 20,
        startsAt: new Date(Date.now() + 86400000),
        endsAt: new Date(Date.now() + 90000000),
        registrationOpensAt: new Date(),
        registrationClosesAt: new Date(Date.now() + 80000000),
        venueSummary: "Test Hall",
        publishedAt: new Date(),
      })
      .onConflictDoNothing();

    await client.db
      .insert(eventInvitations)
      .values({
        eventId: invitedEventId,
        email: invitedEmail,
        invitedBy: U(14),
      })
      .onConflictDoNothing();
    adminToken = (await login("principal@demo.campusops.local")).accessToken;
    facultyToken = (await login("faculty.cse@demo.campusops.local")).accessToken;
    seniorToken = (await login("hoddean.cse@demo.campusops.local")).accessToken;
    codingLeadToken = (await login("coding.lead@demo.campusops.local")).accessToken;
    roboticsToken = (await login("robotics.coordinator@demo.campusops.local")).accessToken;
  });

  afterAll(async () => {
    if (client) {
      await client.db.delete(eventInvitations).where(eq(eventInvitations.eventId, invitedEventId));
      await client.db.delete(events).where(eq(events.id, invitedEventId));
      await client.db.delete(events).where(eq(events.id, collegeEventId));
      await closeDb(client);
    }
  });

  test("college registration requires email verification then faculty verification", async () => {
    const reg = await req("POST", "/api/v1/auth/register/college", {
      email: collegeEmail,
      password: PASSWORD,
      fullName: "Phase 2 College Student",
      institutionName: "Demo College",
      rollNumber: `P2-${stamp}`,
      departmentId: U(1),
      collegeIdNumber: `ID-${stamp}`,
      client: "mobile",
    });
    expect(reg.status).toBe(201);
    const regData = data<{
      user: { id: string; status: string };
      verification: { challengeId: string; demoOtp: string };
    }>(reg);
    collegeId = regData.user.id;
    expect(regData.user.status).toBe("PENDING_EMAIL");
    expect(regData.verification.demoOtp).toMatch(/^\d{6}$/);

    const early = await login(collegeEmail);
    collegeToken = early.accessToken;
    collegeRefresh = early.refreshToken;
    const blocked = await req("GET", "/api/v1/events", undefined, collegeToken);
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked)).toBe("ACCOUNT_PENDING");

    const verifiedEmail = await req("POST", "/api/v1/auth/verify-email", {
      challengeId: regData.verification.challengeId,
      otp: regData.verification.demoOtp,
    });
    expect(verifiedEmail.status).toBe(200);
    expect(data<{ user: { status: string } }>(verifiedEmail).user.status).toBe(
      "PENDING_VERIFICATION",
    );

    const stillBlocked = await req("GET", "/api/v1/events", undefined, collegeToken);
    expect(stillBlocked.status).toBe(403);

    const seniorAttempt = await req(
      "POST",
      `/api/v1/faculty/students/${collegeId}/verify`,
      { note: "no" },
      seniorToken,
    );
    expect(seniorAttempt.status).toBe(403);

    // The pending queue accumulates across runs, so page until the account is
    // found rather than assuming it lands on the first page.
    let queueFound = false;
    for (let offset = 0; offset < 1000 && !queueFound; offset += 100) {
      const queue = await req(
        "GET",
        `/api/v1/faculty/verification-queue?limit=100&offset=${offset}`,
        undefined,
        facultyToken,
      );
      expect(queue.status).toBe(200);
      const page = data<{ items: Array<{ id: string }>; hasMore: boolean }>(queue);
      queueFound = page.items.some((i) => i.id === collegeId);
      if (!page.hasMore) break;
    }
    expect(queueFound).toBe(true);

    const facultyVerify = await req(
      "POST",
      `/api/v1/faculty/students/${collegeId}/verify`,
      { note: "checked college ID" },
      facultyToken,
    );
    expect(facultyVerify.status).toBe(200);
    // Filter instead of assuming the seeded event sits on page 1: other test
    // files create events, and the default page is 25 rows.
    const allowed = await req(
      "GET",
      `/api/v1/events?q=${encodeURIComponent(collegeEventTitle)}&limit=100`,
      undefined,
      collegeToken,
    );
    expect(allowed.status).toBe(200);
    expect(
      data<{ items: Array<{ id: string }> }>(allowed).items.some((e) => e.id === collegeEventId),
    ).toBe(true);
  });

  test("outsider self-verifies but cannot see college-only events; invited-only works by invitation", async () => {
    const reg = await req("POST", "/api/v1/auth/register/outsider", {
      email: outsiderEmail,
      password: PASSWORD,
      fullName: "Phase 2 Outsider",
      institutionName: "Other College",
      client: "mobile",
    });
    expect(reg.status).toBe(201);
    const v = data<{ verification: { challengeId: string; demoOtp: string } }>(reg).verification;
    const verify = await req("POST", "/api/v1/auth/verify-email", {
      challengeId: v.challengeId,
      otp: v.demoOtp,
    });
    expect(verify.status).toBe(200);
    expect(data<{ user: { status: string } }>(verify).user.status).toBe("ACTIVE");
    outsiderToken = (await login(outsiderEmail)).accessToken;

    const list = await req(
      "GET",
      "/api/v1/events?q=AI%20Seminar&limit=100",
      undefined,
      outsiderToken,
    );
    expect(list.status).toBe(200);
    const ids = data<{ items: Array<{ id: string }> }>(list).items.map((e) => e.id);
    expect(ids).toContain(U(81));
    // Negative visibility is asserted by direct fetch: absence from a paginated
    // list would pass even if the event were wrongly visible.
    const hidden = await req("GET", `/api/v1/events/${collegeEventId}`, undefined, outsiderToken);
    expect(hidden.status).toBe(404);
    const notInvited = await req(
      "GET",
      `/api/v1/events/${invitedEventId}`,
      undefined,
      outsiderToken,
    );
    expect(notInvited.status).toBe(404);

    const invitedReg = await req("POST", "/api/v1/auth/register/outsider", {
      email: invitedEmail,
      password: PASSWORD,
      fullName: "Phase 2 Invited Outsider",
      institutionName: "Other College",
      client: "mobile",
    });
    const iv = data<{ verification: { challengeId: string; demoOtp: string } }>(
      invitedReg,
    ).verification;
    await req("POST", "/api/v1/auth/verify-email", {
      challengeId: iv.challengeId,
      otp: iv.demoOtp,
    });
    const invitedToken = (await login(invitedEmail)).accessToken;
    const invitedList = await req(
      "GET",
      "/api/v1/events?q=Phase%202%20Invited%20Only%20Test&limit=100",
      undefined,
      invitedToken,
    );
    expect(data<{ items: Array<{ id: string }> }>(invitedList).items.map((e) => e.id)).toContain(
      invitedEventId,
    );
    const invitedGet = await req(
      "GET",
      `/api/v1/events/${invitedEventId}`,
      undefined,
      invitedToken,
    );
    expect(invitedGet.status).toBe(200);
  });

  test("club scope blocks cross-club coordinator access", async () => {
    const own = await req("GET", `/api/v1/clubs/${U(40)}`, undefined, codingLeadToken);
    expect(own.status).toBe(200);
    const other = await req("GET", `/api/v1/clubs/${U(41)}`, undefined, codingLeadToken);
    expect(other.status).toBe(403);
    const otherEvents = await req(
      "GET",
      `/api/v1/clubs/${U(41)}/events`,
      undefined,
      codingLeadToken,
    );
    expect(otherEvents.status).toBe(403);
    const roboticsOwn = await req("GET", `/api/v1/clubs/${U(41)}/events`, undefined, roboticsToken);
    expect(roboticsOwn.status).toBe(200);
    const seniorRead = await req("GET", `/api/v1/clubs/${U(40)}`, undefined, seniorToken);
    expect(seniorRead.status).toBe(200);
    // HOD/Dean now manage clubs in their own department: the seeded senior is
    // HOD/Dean of the coding club's department, so this is allowed...
    const seniorManage = await req(
      "PATCH",
      `/api/v1/clubs/${U(40)}`,
      { description: "Reviewed by the department." },
      seniorToken,
    );
    expect(seniorManage.status).toBe(200);
    // ...but the robotics club sits in another department and stays out of reach.
    const seniorElsewhere = await req(
      "PATCH",
      `/api/v1/clubs/${U(41)}`,
      { description: "not my department" },
      seniorToken,
    );
    expect(seniorElsewhere.status).toBe(403);
  });

  test("refresh rotation invalidates the old refresh token", async () => {
    const first = await req("POST", "/api/v1/auth/refresh", {
      refreshToken: collegeRefresh,
      client: "mobile",
    });
    expect(first.status).toBe(200);
    const rotated = data<{ refreshToken: string }>(first).refreshToken;
    expect(rotated).not.toBe(collegeRefresh);
    const reuse = await req("POST", "/api/v1/auth/refresh", {
      refreshToken: collegeRefresh,
      client: "mobile",
    });
    expect(reuse.status).toBe(401);
    const afterReuse = await req("POST", "/api/v1/auth/refresh", {
      refreshToken: rotated,
      client: "mobile",
    });
    expect(afterReuse.status).toBe(401);
  });

  test("admin provisions staff, assigns roles, suspends and reactivates", async () => {
    const provision = await req(
      "POST",
      "/api/v1/admin/staff",
      {
        email: staffEmail,
        fullName: "Phase 2 Staff",
        designation: "Test Faculty",
        departmentId: U(1),
      },
      adminToken,
    );
    expect(provision.status).toBe(201);
    const provisionData = data<{ user: { id: string } }>(provision);
    expect((provision.json.data as Json | undefined)?.verification).toBeUndefined();
    const forgotStaff = await req("POST", "/api/v1/auth/forgot-password", {
      email: staffEmail,
    });
    expect(forgotStaff.status).toBe(200);
    const setupCode = data<{ verification: { demoOtp: string } }>(forgotStaff).verification;
    expect(setupCode.demoOtp).toMatch(/^\d{6}$/);
    const setup = await req("POST", "/api/v1/auth/reset-password", {
      email: staffEmail,
      otp: setupCode.demoOtp,
      newPassword: PASSWORD,
    });
    expect(setup.status).toBe(200);
    const staffLogin = await login(staffEmail);
    const grant = await req(
      "POST",
      `/api/v1/admin/users/${provisionData.user.id}/roles`,
      {
        role: "FACULTY",
        scopeType: "DEPARTMENT",
        departmentId: U(1),
      },
      adminToken,
    );
    expect(grant.status).toBe(201);
    const staffQueue = await req(
      "GET",
      "/api/v1/faculty/verification-queue",
      undefined,
      staffLogin.accessToken,
    );
    expect(staffQueue.status).toBe(200);

    const selfSuspend = await req(
      "POST",
      `/api/v1/admin/users/${U(10)}/suspend`,
      { reason: "self suspension guard" },
      adminToken,
    );
    expect(selfSuspend.status).toBe(403);

    const suspend = await req(
      "POST",
      `/api/v1/admin/users/${provisionData.user.id}/suspend`,
      { reason: "phase 2 test" },
      adminToken,
    );
    expect(suspend.status).toBe(200);
    const suspendedAccess = await req("GET", "/api/v1/me", undefined, staffLogin.accessToken);
    // Suspension revokes sessions, so an already-issued access token is rejected at the session check.
    expect([401, 403]).toContain(suspendedAccess.status);
    const reactivate = await req(
      "POST",
      `/api/v1/admin/users/${provisionData.user.id}/reactivate`,
      { reason: "test complete" },
      adminToken,
    );
    expect(reactivate.status).toBe(200);
    expect(data<{ user: { status: string } }>(reactivate).user.status).toBe("ACTIVE");

    const nonAdmin = await req("GET", "/api/v1/admin/users", undefined, facultyToken);
    expect(nonAdmin.status).toBe(403);
    // Search rather than assume the seeded admin sits on page 1: the test
    // database accumulates users across runs, which pushes it off the first page.
    const lastAdmin = await req(
      "GET",
      "/api/v1/admin/users?q=principal@demo.campusops.local",
      undefined,
      adminToken,
    );
    expect(lastAdmin.status).toBe(200);
    const adminUser = data<{ items: Array<{ id: string }> }>(lastAdmin).items.find(
      (u) => u.id === U(10),
    );
    expect(adminUser).toBeTruthy();
  });

  test("password reset and change revoke sessions; faculty can correct profiles", async () => {
    const forgot = await req("POST", "/api/v1/auth/forgot-password", { email: outsiderEmail });
    expect(forgot.status).toBe(200);
    const resetChallenge = data<{ verification: { demoOtp: string } }>(forgot).verification;
    expect(resetChallenge.demoOtp).toMatch(/^\d{6}$/);
    const newPassword = "Phase2-Reset-Password!";
    const reset = await req("POST", "/api/v1/auth/reset-password", {
      email: outsiderEmail,
      otp: resetChallenge.demoOtp,
      newPassword,
    });
    expect(reset.status).toBe(200);
    const oldLogin = await req("POST", "/api/v1/auth/login", {
      email: outsiderEmail,
      password: PASSWORD,
      client: "mobile",
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await req("POST", "/api/v1/auth/login", {
      email: outsiderEmail,
      password: newPassword,
      client: "mobile",
    });
    expect(newLogin.status).toBe(200);
    const newToken = data<{ accessToken: string }>(newLogin).accessToken;
    const changed = await req(
      "POST",
      "/api/v1/auth/change-password",
      { currentPassword: newPassword, newPassword: PASSWORD },
      newToken,
    );
    expect(changed.status).toBe(200);
    const afterChange = await req("GET", "/api/v1/me", undefined, newToken);
    expect(afterChange.status).toBe(401);
    outsiderToken = (await login(outsiderEmail)).accessToken;

    // The refresh-reuse test intentionally revoked all of this student's sessions.
    collegeToken = (await login(collegeEmail)).accessToken;
    const patch = await req(
      "PATCH",
      `/api/v1/faculty/students/${collegeId}/profile`,
      { program: "B.Tech CSE", graduationYear: 2027 },
      facultyToken,
    );
    expect(patch.status).toBe(200);
    expect(
      data<{ profile: { program: string; profileVersion: number } }>(patch).profile.program,
    ).toBe("B.Tech CSE");
    const studentSelfPatch = await req(
      "PATCH",
      `/api/v1/faculty/students/${collegeId}/profile`,
      { program: "no" },
      collegeToken,
    );
    expect(studentSelfPatch.status).toBe(403);
  });

  test("web refresh works with httpOnly cookie and no JSON body", async () => {
    const loginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "student.verified@demo.campusops.local",
        password: PASSWORD,
        client: "web",
      }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("campusops_refresh=");
    const refreshRes = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(refreshRes.status).toBe(200);
    const refreshJson = (await refreshRes.json()) as Json;
    expect((refreshJson.data as { accessToken?: string }).accessToken).toBeTruthy();
    expect((refreshJson.data as { refreshToken?: string }).refreshToken).toBeUndefined();
  });

  test("identity and role actions are audited without secrets", async () => {
    const { db } = getDb();
    const rows = await db.execute<{ action: string; after_data: unknown }>(
      sql`SELECT action, after_data FROM audit_logs WHERE action IN ('AUTH_REGISTER_COLLEGE','FACULTY_STUDENT_VERIFIED','ADMIN_STAFF_PROVISIONED','ADMIN_ROLE_GRANTED') ORDER BY created_at DESC LIMIT 20`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("demoOtp");
    expect(serialized).not.toContain("refreshToken");
  });
});
