import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  checkpoints,
  clubMemberships,
  clubs,
  departments,
  passes,
  redemptions,
  registrations,
  roleAssignments,
  scanLogs,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

const app = createApp();
const PASSWORD = "Access-Test-Password!";
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

async function account(label: string, kind: "staff" | "student", role?: "ADMIN" | "FACULTY") {
  const { db } = getDb();
  const email = `acc.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: kind === "staff" ? "STAFF" : "COLLEGE_STUDENT",
      status: "ACTIVE",
      fullName: `Access ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!u) throw new Error("insert failed");
  if (role) {
    await db
      .insert(staffProfiles)
      .values({ userId: u.id, departmentId: ids.dept as string, designation: role });
    await db.insert(roleAssignments).values({
      userId: u.id,
      role,
      scopeType: role === "ADMIN" ? "GLOBAL" : "DEPARTMENT",
      departmentId: role === "ADMIN" ? null : (ids.dept as string),
    });
  }
  if (kind === "student") {
    await db.insert(studentProfiles).values({
      userId: u.id,
      studentKind: "COLLEGE_STUDENT",
      rollNumber: `AC${stamp}${rnd()}`.slice(0, 20),
      collegeIdNumber: `ID-${rnd()}`,
      departmentId: ids.dept as string,
      institutionName: "Test College",
    });
  }
  const login = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  tokens[label] = login.json.data.accessToken;
  ids[label] = u.id;
  return u.id;
}

/** The event's own window, wide enough that a scan now is inside it. */
const hours = (from: number, to: number) => ({
  startsAt: new Date(Date.now() + from * 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + to * 3_600_000).toISOString(),
});

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `AC${stamp}`.slice(0, 20), name: "Access Dept" })
    .returning();
  if (!dept) throw new Error("dept failed");
  ids.dept = dept.id;

  await account("admin", "staff", "ADMIN");
  await account("faculty", "staff", "FACULTY");
  await account("unrelatedFaculty", "staff", "FACULTY");
  await account("lead", "staff");
  await account("coordinator", "staff");
  await account("stranger", "staff");
  await account("student", "student");
  await account("student2", "student");
  await account("waitlisted", "student");

  const [club] = await db
    .insert(clubs)
    .values({
      name: `Access Club ${stamp}`,
      slug: `acc-club-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin as string,
    })
    .returning();
  if (!club) throw new Error("club failed");
  ids.club = club.id;
  await db.insert(clubMemberships).values([
    { clubId: club.id, userId: ids.lead as string, clubRole: "LEAD" },
    { clubId: club.id, userId: ids.coordinator as string, clubRole: "COORDINATOR" },
    // The club's faculty organise and scan; there is no advisor and no scanner
    // staff account anywhere in this setup.
    { clubId: club.id, userId: ids.faculty as string, clubRole: "FACULTY" },
  ]);

  const w = hours(-1, 8);
  const [event] = await db
    .insert(events)
    .values({
      clubId: club.id,
      title: `One Day Fest ${stamp}`,
      slug: `one-day-fest-${stamp}`,
      description: "A single-day event exercising every access policy.",
      template: "CUSTOM",
      audience: "COLLEGE_ONLY",
      admissionMode: "FCFS",
      capacity: 100,
      startsAt: new Date(w.startsAt),
      endsAt: new Date(w.endsAt),
      registrationOpensAt: new Date(Date.now() - 10 * 86_400_000),
      registrationClosesAt: new Date(w.startsAt),
      venueSummary: "Main Ground",
      status: "LIVE",
      publishedAt: new Date(Date.now() - 5 * 86_400_000),
      createdBy: ids.lead as string,
    })
    .returning();
  if (!event) throw new Error("event failed");
  ids.event = event.id;

  for (const label of ["student", "student2", "waitlisted"]) {
    const [reg] = await db
      .insert(registrations)
      .values({
        eventId: event.id,
        userId: ids[label] as string,
        status: label === "waitlisted" ? "WAITLISTED" : "CONFIRMED",
        admissionModeSnapshot: "FCFS",
        eligibilitySnapshot: { version: 1 },
        eventRevision: 1,
        ...(label === "waitlisted" ? { queuePosition: 1 } : { confirmedAt: new Date() }),
      })
      .returning();
    if (!reg) throw new Error("registration failed");
    ids[`reg_${label}`] = reg.id;
  }
});

/** Create a counter through the portal API, as a coordinator would. */
async function counter(name: string, over: Body = {}) {
  const res = await req(
    "POST",
    `/api/v1/events/${ids.event}/checkpoints`,
    {
      name,
      qrType: "UNLIMITED",
      maxUses: null,
      validityMode: "WINDOW",
      validFrom: hours(-1, 8).startsAt,
      validUntil: hours(-1, 8).endsAt,
      ...over,
    },
    tokens.lead,
  );
  expect(res.status).toBe(201);
  return res.json.data as Body;
}

/** Mint the participant's own rotating code, then scan it as an organiser. */
async function mintThenScan(
  checkpointId: string,
  student = "student",
  scanner = "lead",
  over: Body = {},
) {
  const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens[student]);
  const pass = wallet.json.data.items.find((i: Body) => i.event.id === ids.event);
  const minted = await req(
    "POST",
    `/api/v1/me/passes/${pass.passId}/nonce`,
    { checkpointId },
    tokens[student],
  );
  expect(minted.status).toBe(200);
  return req(
    "POST",
    "/api/v1/access/scan",
    { token: minted.json.data.token, checkpointId, identityCheck: "MATCH", ...over },
    tokens[scanner],
  );
}

describe("access QR configuration in the portal", () => {
  test("the coordinator defines names, types and validity without a purpose list", async () => {
    const gate = await counter("Main gate", { qrType: "TOGGLE" });
    const attendance = await counter("Attendance", {
      qrType: "ONE_TIME",
      validityMode: "DATE",
      validOn: new Intl.DateTimeFormat("en-CA", {
        timeZone: process.env.CAMPUS_TIMEZONE ?? "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
      validFrom: null,
      validUntil: null,
    });
    const lunch = await counter("Lunch", {
      qrType: "ONE_TIME",
      validityMode: "MANUAL",
      validFrom: null,
      validUntil: null,
    });
    const books = await counter("Book issue", { qrType: "COUNTED", maxUses: 3 });
    const dj = await counter("DJ night", { qrType: "UNLIMITED" });
    ids.entry = gate.id;
    ids.meal = lunch.id;
    ids.books = books.id;
    ids.dj = dj.id;
    ids.attendance = attendance.id;
    expect(gate?.qrType).toBe("TOGGLE");
    expect(gate.maxUses).toBeNull();
    expect(attendance.validityMode).toBe("DATE");
    expect(lunch?.validityMode).toBe("MANUAL");
    expect(books.maxUses).toBe(3);
    const list = await req(
      "GET",
      `/api/v1/events/${ids.event}/checkpoints`,
      undefined,
      tokens.lead,
    );
    expect(list.status).toBe(200);
    expect(list.json.data.items.length).toBe(5);
    expect(list.json.data.items[0].uses).toBe(0);
  });

  test("any nonblank name is accepted and uniqueness ignores case", async () => {
    const cp = await counter("xyz");
    const duplicate = await req(
      "POST",
      `/api/v1/events/${ids.event}/checkpoints`,
      {
        name: "XYZ",
        qrType: "ONE_TIME",
        validityMode: "MANUAL",
      },
      tokens.lead,
    );
    expect(duplicate.status).toBe(409);
    expect(
      (await req("DELETE", `/api/v1/access/checkpoints/${cp.id}`, undefined, tokens.lead)).status,
    ).toBe(200);
  });

  test("invalid type/validity combinations are rejected before the database", async () => {
    const base = { name: `Invalid ${rnd()}`, qrType: "COUNTED", validityMode: "MANUAL" };
    for (const over of [
      { maxUses: null },
      { maxUses: 0 },
      { qrType: "ONE_TIME", maxUses: 2 },
      { validityMode: "WINDOW" },
      { validityMode: "DATE" },
      { validityMode: "DATE", validOn: "2026-02-30" },
    ]) {
      const res = await req(
        "POST",
        `/api/v1/events/${ids.event}/checkpoints`,
        { ...base, ...over },
        tokens.lead,
      );
      expect(res.status).toBe(400);
    }
  });

  test("a counter name cannot be reused within the event", async () => {
    const res = await req(
      "POST",
      `/api/v1/events/${ids.event}/checkpoints`,
      { name: "lUnCh", qrType: "ONE_TIME", validityMode: "MANUAL" },
      tokens.lead,
    );
    expect(res.status).toBe(409);
  });

  test("a counter must close after it opens", async () => {
    const res = await req(
      "POST",
      `/api/v1/events/${ids.event}/checkpoints`,
      {
        name: "Backwards",
        qrType: "ONE_TIME",
        validityMode: "WINDOW",
        validFrom: hours(2, 3).startsAt,
        validUntil: hours(-2, -1).endsAt,
      },
      tokens.lead,
    );
    expect(res.status).toBe(400);
  });

  test("only the event's coordinators configure counters, not any staff account", async () => {
    const res = await req(
      "POST",
      `/api/v1/events/${ids.event}/checkpoints`,
      { name: "Sneaky", qrType: "ONE_TIME", validityMode: "MANUAL" },
      tokens.stranger,
    );
    expect(res.status).toBe(403);
    // Club faculty organise the event but configuration stays with coordinators.
    const faculty = await req(
      "POST",
      `/api/v1/events/${ids.event}/checkpoints`,
      { name: "Faculty made", qrType: "ONE_TIME", validityMode: "MANUAL" },
      tokens.faculty,
    );
    expect(faculty.status).toBe(403);
    // Oversight can read the rules and the scan log, but changing them is the
    // coordinators' job.
    const admin = await req(
      "POST",
      `/api/v1/events/${ids.event}/checkpoints`,
      { name: "Admin made", qrType: "ONE_TIME", validityMode: "MANUAL" },
      tokens.admin,
    );
    expect(admin.status).toBe(403);
  });

  test("a counter can be added while the event is already running", async () => {
    const late = await counter("Pop-up stall");
    const del = await req(
      "DELETE",
      `/api/v1/access/checkpoints/${late.id}`,
      undefined,
      tokens.lead,
    );
    expect(del.status).toBe(200);
  });

  test("the live switch can be flipped mid-event", async () => {
    const off = await req(
      "PATCH",
      `/api/v1/access/checkpoints/${ids.dj}/active`,
      { isActive: false },
      tokens.coordinator,
    );
    expect(off.status).toBe(200);
    expect(off.json.data.isActive).toBe(false);
    const on = await req(
      "PATCH",
      `/api/v1/access/checkpoints/${ids.dj}/active`,
      { isActive: true },
      tokens.coordinator,
    );
    expect(on.json.data.isActive).toBe(true);
  });
});

describe("pass issuance", () => {
  test("passes are issued only to confirmed participants, and re-issuing is safe", async () => {
    const first = await req("POST", `/api/v1/events/${ids.event}/passes/issue`, {}, tokens.lead);
    expect(first.status).toBe(200);
    expect(first.json.data.created).toBe(2);
    expect(first.json.data.confirmed).toBe(2);
    const again = await req("POST", `/api/v1/events/${ids.event}/passes/issue`, {}, tokens.lead);
    expect(again.json.data.created).toBe(0);

    const { db } = getDb();
    const rows = await db.select().from(passes);
    const forEvent = rows.filter(
      (p) =>
        p.registrationId === ids.reg_student ||
        p.registrationId === ids.reg_student2 ||
        p.registrationId === ids.reg_waitlisted,
    );
    expect(forEvent).toHaveLength(2);
  });

  test("a participant sees only their own passes", async () => {
    const mine = await req("GET", "/api/v1/me/passes", undefined, tokens.student);
    expect(mine.status).toBe(200);
    const items = mine.json.data.items as Body[];
    expect(items).toHaveLength(1);
    expect(items[0]?.event.id).toBe(ids.event);
    expect(items[0]?.checkpoints).toHaveLength(5);
    const other = await req("GET", "/api/v1/me/passes", undefined, tokens.waitlisted);
    expect(other.json.data.items).toHaveLength(0);
  });

  test("a code cannot be minted against another event's counter", async () => {
    const { db } = getDb();
    const [otherEvent] = await db
      .insert(events)
      .values({
        clubId: ids.club as string,
        title: `Other ${rnd()}`,
        slug: `other-${stamp}-${rnd()}`,
        description: "Another event entirely.",
        template: "WORKSHOP",
        audience: "COLLEGE_ONLY",
        admissionMode: "FCFS",
        capacity: 10,
        ...(() => {
          const w = hours(24, 30);
          return {
            startsAt: new Date(w.startsAt),
            endsAt: new Date(w.endsAt),
            registrationOpensAt: new Date(Date.now() - 86_400_000),
            registrationClosesAt: new Date(w.startsAt),
          };
        })(),
        venueSummary: "Elsewhere",
        createdBy: ids.lead as string,
      })
      .returning();
    const [cp] = await db
      .insert(checkpoints)
      .values({
        eventId: otherEvent?.id as string,
        name: "Other gate",
        qrType: "UNLIMITED",
        validityMode: "WINDOW",
        startsAt: new Date(Date.now() + 24 * 3_600_000),
        endsAt: new Date(Date.now() + 30 * 3_600_000),
        createdBy: ids.lead as string,
      })
      .returning();
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student);
    const pass = wallet.json.data.items[0];
    const res = await req(
      "POST",
      `/api/v1/me/passes/${pass.passId}/nonce`,
      { checkpointId: cp?.id },
      tokens.student,
    );
    expect(res.status).toBe(400);
  });
});

describe("scanning at the counter", () => {
  test("one toggle QR alternates entry and exit for the same participant", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await mintThenScan(ids.entry as string);
      expect(res.status).toBe(200);
      expect(res.json.data.result).toBe("GRANTED");
      expect(res.json.data.useNumber).toBe(i + 1);
      expect(res.json.data.remainingAfter).toBeNull();
      expect(res.json.data.participant.fullName).toBe("Access student");
      expect(res.json.data.participant.collegeIdNumber).toBeTruthy();
      expect(res.json.data.direction).toBe(i % 2 === 0 ? "IN" : "OUT");
    }
  });

  test("the club's faculty can scan, and so can a coordinator", async () => {
    expect((await mintThenScan(ids.entry as string, "student", "faculty")).json.data.result).toBe(
      "GRANTED",
    );
    expect(
      (await mintThenScan(ids.entry as string, "student", "coordinator")).json.data.result,
    ).toBe("GRANTED");
  });

  test("staff who are not organising this event cannot scan", async () => {
    const res = await mintThenScan(ids.entry as string, "student", "stranger");
    expect(res.status).toBe(403);
    const unrelated = await mintThenScan(ids.entry as string, "student", "unrelatedFaculty");
    expect(unrelated.status).toBe(403);
    const admin = await mintThenScan(ids.entry as string, "student", "admin");
    expect(admin.status).toBe(403);
  });

  test("a meal grants once; a second attempt says the turns are used", async () => {
    const first = await mintThenScan(ids.meal as string, "student2");
    expect(first.json.data.result).toBe("GRANTED");
    expect(first.json.data.useNumber).toBe(1);
    const second = await mintThenScan(ids.meal as string, "student2");
    expect(second.json.data.result).toBe("DENIED");
    expect(second.json.data.reason).toBe("LIMIT_REACHED");
    expect(second.json.data.message).not.toBe("LIMIT_REACHED");
  });

  test("a paused meal counter denies a participant who has never used it", async () => {
    await req(
      "PATCH",
      `/api/v1/access/checkpoints/${ids.meal}/active`,
      { isActive: false },
      tokens.lead,
    );
    const res = await mintThenScan(ids.meal as string, "student");
    expect(res.json.data.reason).toBe("QR_SWITCHED_OFF");
    await req(
      "PATCH",
      `/api/v1/access/checkpoints/${ids.meal}/active`,
      { isActive: true },
      tokens.lead,
    );
    expect((await mintThenScan(ids.meal as string, "student")).json.data.result).toBe("GRANTED");
  });

  test("book issue allows three and refuses the fourth", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await mintThenScan(ids.books as string, "student");
      expect(res.json.data.result).toBe("GRANTED");
      expect(res.json.data.useNumber).toBe(i);
      expect(res.json.data.remainingAfter).toBe(3 - i);
    }
    expect((await mintThenScan(ids.books as string, "student")).json.data.reason).toBe(
      "LIMIT_REACHED",
    );
  });

  test("a screenshot cannot be replayed by a friend", async () => {
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student2);
    const pass = wallet.json.data.items[0];
    const minted = await req(
      "POST",
      `/api/v1/me/passes/${pass.passId}/nonce`,
      { checkpointId: ids.entry },
      tokens.student2,
    );
    const token = minted.json.data.token;
    const first = await req(
      "POST",
      "/api/v1/access/scan",
      { token, checkpointId: ids.entry, identityCheck: "MATCH" },
      tokens.lead,
    );
    expect(first.json.data.result).toBe("GRANTED");
    const replay = await req(
      "POST",
      "/api/v1/access/scan",
      { token, checkpointId: ids.entry, identityCheck: "MATCH" },
      tokens.coordinator,
    );
    expect(replay.json.data.result).toBe("DENIED");
    expect(replay.json.data.reason).toBe("QR_REPLAYED");
  });

  test("an entry code cannot be used at the meal counter", async () => {
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student2);
    const pass = wallet.json.data.items[0];
    const minted = await req(
      "POST",
      `/api/v1/me/passes/${pass.passId}/nonce`,
      { checkpointId: ids.entry },
      tokens.student2,
    );
    const res = await req(
      "POST",
      "/api/v1/access/scan",
      { token: minted.json.data.token, checkpointId: ids.meal, identityCheck: "MATCH" },
      tokens.lead,
    );
    expect(res.json.data.reason).toBe("WRONG_CHECKPOINT");
  });

  test("someone attending on another's behalf is refused", async () => {
    const res = await mintThenScan(ids.dj as string, "student2", "lead", {
      identityCheck: "MISMATCH",
    });
    expect(res.json.data.result).toBe("DENIED");
    expect(res.json.data.reason).toBe("IDENTITY_MISMATCH");
    // The refusal used no turn: the real person can still come.
    const real = await mintThenScan(ids.dj as string, "student2");
    expect(real.json.data.result).toBe("GRANTED");
  });

  test("showing a code at the wrong counter does not burn it", async () => {
    const cp = await counter("Wrong-gate probe", { qrType: "UNLIMITED", maxUses: null });
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student);
    const pass = wallet.json.data.items[0];
    const minted = await req(
      "POST",
      `/api/v1/me/passes/${pass.passId}/nonce`,
      { checkpointId: cp.id },
      tokens.student,
    );
    const token = minted.json.data.token;
    const wrong = await req(
      "POST",
      "/api/v1/access/scan",
      { token, checkpointId: ids.entry, identityCheck: "MATCH" },
      tokens.lead,
    );
    expect(wrong.json.data.reason).toBe("WRONG_CHECKPOINT");
    // The same code still works at the counter it was minted for.
    const right = await req(
      "POST",
      "/api/v1/access/scan",
      { token, checkpointId: cp.id, identityCheck: "MATCH" },
      tokens.lead,
    );
    expect(right.json.data.result).toBe("GRANTED");
  });

  test("a garbage code is denied and logged, never a server error", async () => {
    const res = await req(
      "POST",
      "/api/v1/access/scan",
      { token: "not-a-real-token", checkpointId: ids.entry, identityCheck: "MATCH" },
      tokens.lead,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.result).toBe("DENIED");
  });

  test("two simultaneous scans cannot both grant the last turn", async () => {
    const race = await counter("Race counter", { qrType: "ONE_TIME", maxUses: null });
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student2);
    const pass = wallet.json.data.items[0];
    const codes = await Promise.all(
      [0, 1].map(() =>
        req(
          "POST",
          `/api/v1/me/passes/${pass.passId}/nonce`,
          { checkpointId: race.id },
          tokens.student2,
        ),
      ),
    );
    const results = await Promise.all(
      codes.map((c, i) =>
        req(
          "POST",
          "/api/v1/access/scan",
          {
            token: c.json.data.token,
            checkpointId: race.id,
            identityCheck: "MATCH",
          },
          i === 0 ? tokens.lead : tokens.coordinator,
        ),
      ),
    );
    const granted = results.filter((r) => r.json.data.result === "GRANTED");
    expect(granted).toHaveLength(1);
    const { db } = getDb();
    const rows = await db.select().from(redemptions).where(eq(redemptions.checkpointId, race.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.useNumber).toBe(1);
  });
});

describe("the record the portal shows", () => {
  test("the access log records who, when, which counter and the outcome", async () => {
    const log = await req(
      "GET",
      `/api/v1/events/${ids.event}/access-log?limit=100`,
      undefined,
      tokens.lead,
    );
    expect(log.status).toBe(200);
    const items = log.json.data.items as Body[];
    expect(items.length).toBeGreaterThan(10);
    const granted = items.find((i) => i.result === "GRANTED");
    expect(granted?.scanner.fullName).toBeTruthy();
    expect(granted?.checkpointName).toBeTruthy();
    expect(granted?.createdAt).toBeTruthy();
    expect([ids.student, ids.student2]).toContain(granted?.participantId);
    expect(items.some((i) => i.result === "DENIED")).toBe(true);
  });

  test("the log can be filtered by counter and outcome", async () => {
    const res = await req(
      "GET",
      `/api/v1/events/${ids.event}/access-log?checkpointId=${ids.meal}&result=GRANTED`,
      undefined,
      tokens.lead,
    );
    const items = res.json.data.items as Body[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.checkpointId === ids.meal && i.result === "GRANTED")).toBe(true);
  });

  test("usage counts and pass holders are visible to the organisers", async () => {
    const list = await req(
      "GET",
      `/api/v1/events/${ids.event}/checkpoints`,
      undefined,
      tokens.lead,
    );
    const meal = list.json.data.items.find((i: Body) => i.id === ids.meal);
    expect(meal.uses).toBe(2);
    expect(meal.people).toBe(2);
    const holders = await req(
      "GET",
      `/api/v1/events/${ids.event}/passes`,
      undefined,
      tokens.faculty,
    );
    expect(holders.status).toBe(200);
    expect(holders.json.data.items).toHaveLength(2);
    expect(holders.json.data.items[0].uses).toBeGreaterThan(0);
  });

  test("a used counter cannot be deleted, but can be closed", async () => {
    const del = await req(
      "DELETE",
      `/api/v1/access/checkpoints/${ids.meal}`,
      undefined,
      tokens.lead,
    );
    expect(del.status).toBe(409);
    const close = await req(
      "PATCH",
      `/api/v1/access/checkpoints/${ids.meal}/active`,
      { isActive: false },
      tokens.lead,
    );
    expect(close.status).toBe(200);
    const { db } = getDb();
    const kept = await db
      .select()
      .from(redemptions)
      .where(eq(redemptions.checkpointId, ids.meal as string));
    expect(kept.length).toBe(2);
  });

  test("a counter with only refused scans still cannot be deleted", async () => {
    const cp = await counter("Refusals only", { qrType: "ONE_TIME", maxUses: null });
    const denied = await req(
      "POST",
      "/api/v1/access/scan",
      { token: "forged-code", checkpointId: cp.id, identityCheck: "MATCH" },
      tokens.lead,
    );
    expect(denied.json.data.result).toBe("DENIED");
    const del = await req("DELETE", `/api/v1/access/checkpoints/${cp.id}`, undefined, tokens.lead);
    expect(del.status).toBe(409);
  });

  test("the scan log never exposes the replay-guard hash", async () => {
    const log = await req(
      "GET",
      `/api/v1/events/${ids.event}/access-log?limit=5`,
      undefined,
      tokens.lead,
    );
    for (const item of log.json.data.items as Body[]) {
      expect(item.nonceHash).toBeUndefined();
    }
  });

  test("a limit cannot be lowered below what someone already used", async () => {
    const res = await req(
      "PATCH",
      `/api/v1/access/checkpoints/${ids.books}`,
      {
        name: "Book issue",
        qrType: "COUNTED",
        maxUses: 1,
        validityMode: "WINDOW",
        validFrom: hours(-1, 8).startsAt,
        validUntil: hours(-1, 8).endsAt,
      },
      tokens.lead,
    );
    expect(res.status).toBe(409);
    const raise = await req(
      "PATCH",
      `/api/v1/access/checkpoints/${ids.books}`,
      {
        name: "Book issue",
        qrType: "COUNTED",
        maxUses: 5,
        validityMode: "WINDOW",
        validFrom: hours(-1, 8).startsAt,
        validUntil: hours(-1, 8).endsAt,
      },
      tokens.lead,
    );
    expect(raise.status).toBe(200);
    // Raising it mid-event lets the participant continue from use four.
    const res4 = await mintThenScan(ids.books as string, "student");
    expect(res4.json.data.result).toBe("GRANTED");
    expect(res4.json.data.useNumber).toBe(4);
  });

  test("revoking a pass stops that participant without closing the counter", async () => {
    const holders = await req("GET", `/api/v1/events/${ids.event}/passes`, undefined, tokens.lead);
    const target = holders.json.data.items.find((i: Body) => i.user.id === ids.student2);
    const revoke = await req(
      "POST",
      `/api/v1/access/passes/${target.passId}/revoke`,
      {},
      tokens.coordinator,
    );
    expect(revoke.status).toBe(200);
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student2);
    expect(wallet.json.data.items[0].checkpoints.every((c: Body) => c.availableNow === false)).toBe(
      true,
    );
    const again = await req(
      "POST",
      `/api/v1/me/passes/${target.passId}/nonce`,
      { checkpointId: ids.entry },
      tokens.student2,
    );
    expect(again.status).toBe(409);
  });

  test("an unconfirmed registration is refused at the counter", async () => {
    const { db } = getDb();
    await db
      .insert(passes)
      .values({ registrationId: ids.reg_waitlisted as string })
      .onConflictDoNothing();
    const res = await mintThenScan(ids.entry as string, "waitlisted");
    expect(res.json.data.reason).toBe("NOT_CONFIRMED");
  });

  test("scans stop being granted once the event is no longer live", async () => {
    const { db } = getDb();
    await db
      .update(events)
      .set({ status: "COMPLETED" })
      .where(eq(events.id, ids.event as string));
    const res = await mintThenScan(ids.entry as string, "student");
    expect(res.json.data.reason).toBe("EVENT_NOT_LIVE");
    await db
      .update(events)
      .set({ status: "LIVE" })
      .where(eq(events.id, ids.event as string));
  });

  test("the audit trail records configuration changes", async () => {
    const res = await req(
      "GET",
      `/api/v1/events/${ids.event}/audit?action=CHECKPOINT_UPDATED&limit=50`,
      undefined,
      tokens.lead,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.items.length).toBeGreaterThan(0);
  });

  test("housekeeping clears spent QR codes but keeps ones that could still replay", async () => {
    const { db } = getDb();
    const { qrNonces } = await import("../src/db/schema");
    const { pruneOperationalTables } = await import("../src/jobs/maintenance");
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student);
    const passId = wallet.json.data.items[0].passId;
    const longExpired = `expired-${rnd()}`;
    const stillFresh = `fresh-${rnd()}`;
    await db.insert(qrNonces).values([
      {
        nonceHash: longExpired,
        passId,
        checkpointId: ids.entry as string,
        expiresAt: new Date(Date.now() - 2 * 3_600_000),
      },
      {
        nonceHash: stillFresh,
        passId,
        checkpointId: ids.entry as string,
        // Expired, but inside the grace period: pruning it early would let the
        // code be replayed if clocks disagree.
        expiresAt: new Date(Date.now() - 60_000),
      },
    ]);
    const pruned = await pruneOperationalTables();
    expect(pruned.qrNonces).toBeGreaterThanOrEqual(1);
    const remaining = await db
      .select({ h: qrNonces.nonceHash })
      .from(qrNonces)
      .where(eq(qrNonces.passId, passId));
    const hashes = remaining.map((r) => r.h);
    expect(hashes).not.toContain(longExpired);
    expect(hashes).toContain(stillFresh);
  });

  test("no scanning-staff account exists anywhere in the scan history", async () => {
    const { db } = getDb();
    const logs = await db
      .select()
      .from(scanLogs)
      .where(eq(scanLogs.eventId, ids.event as string));
    const scanners = new Set(logs.map((l) => l.scannerId));
    for (const id of scanners) {
      expect([ids.lead, ids.coordinator, ids.faculty]).toContain(id);
    }
  });
});

describe("coordinator-defined rule corrections", () => {
  test("a DATE QR works on the campus date and a MANUAL QR works only while on", async () => {
    const attendance = await mintThenScan(ids.attendance as string, "student");
    expect(attendance.json.data.result).toBe("GRANTED");
    const cp = await counter("Switch-only probe", {
      qrType: "UNLIMITED",
      validityMode: "MANUAL",
      validFrom: null,
      validUntil: null,
      isActive: false,
    });
    expect((await mintThenScan(cp.id, "student")).json.data.reason).toBe("QR_SWITCHED_OFF");
    await req(
      "PATCH",
      `/api/v1/access/checkpoints/${cp.id}/active`,
      { isActive: true },
      tokens.lead,
    );
    expect((await mintThenScan(cp.id, "student")).json.data.result).toBe("GRANTED");
  });

  test("a used QR's type cannot change and its limit cannot go below recorded use", async () => {
    const body = { name: "Book issue", qrType: "ONE_TIME", maxUses: null, validityMode: "MANUAL" };
    const change = await req("PATCH", `/api/v1/access/checkpoints/${ids.books}`, body, tokens.lead);
    expect(change.status).toBe(409);
    const list = await req(
      "GET",
      `/api/v1/events/${ids.event}/checkpoints`,
      undefined,
      tokens.lead,
    );
    const books = list.json.data.items.find((i: Body) => i.id === ids.books);
    expect(books.qrType).toBe("COUNTED");
    expect(books.maxUses).toBe(5);
  });

  test("editing a full rule normalises fields the new mode does not use", async () => {
    const cp = await counter("Editable rule");
    const res = await req(
      "PATCH",
      `/api/v1/access/checkpoints/${cp.id}`,
      {
        name: "Renamed xyz",
        qrType: "COUNTED",
        maxUses: 4,
        validityMode: "MANUAL",
        validFrom: hours(-1, 8).startsAt,
        validUntil: hours(-1, 8).endsAt,
      },
      tokens.coordinator,
    );
    expect(res.status).toBe(400); // MANUAL must not carry a schedule
    const good = await req(
      "PATCH",
      `/api/v1/access/checkpoints/${cp.id}`,
      {
        name: "Renamed xyz",
        qrType: "COUNTED",
        maxUses: 4,
        validityMode: "DATE",
        validOn: "2026-11-14",
      },
      tokens.coordinator,
    );
    expect(good.status).toBe(200);
    expect(good.json.data.startsAt).toBeNull();
    expect(good.json.data.endsAt).toBeNull();
    expect(good.json.data.validOn).toBe("2026-11-14");
  });

  test("the wallet exposes the coordinator's rule and the next toggle direction", async () => {
    const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens.student);
    const cps = wallet.json.data.items[0].checkpoints as Body[];
    const gate = cps.find((c) => c.qrId === ids.entry);
    expect(gate?.name).toBe("Main gate");
    expect(gate?.qrType).toBe("TOGGLE");
    expect(gate?.usedCount).toBeGreaterThan(0);
    expect(["IN", "OUT"]).toContain(gate?.nextDirection);
    const lunch = cps.find((c) => c.qrId === ids.meal);
    expect(lunch?.validityMode).toBe("MANUAL");
    expect(lunch?.summary).toContain("only while switched on");
  });
});
