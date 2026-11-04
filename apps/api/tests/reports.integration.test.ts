import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  clubMemberships,
  clubs,
  departments,
  eventReports,
  registrations,
  roleAssignments,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

const app = createApp();
const PASSWORD = "Report-Test-Password!";
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

async function person(label: string, role?: "ADMIN" | "FACULTY" | "HOD_DEAN", dept?: string) {
  const { db } = getDb();
  const email = `rep.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: "STAFF",
      status: "ACTIVE",
      fullName: `Report ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!u) throw new Error("insert failed");
  if (role) {
    await db
      .insert(staffProfiles)
      .values({ userId: u.id, departmentId: dept ?? null, designation: label });
    await db.insert(roleAssignments).values({
      userId: u.id,
      role,
      scopeType: role === "ADMIN" ? "GLOBAL" : "DEPARTMENT",
      departmentId: role === "ADMIN" ? null : (dept ?? null),
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

const win = (offset: number, a = 9, b = 12) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  const at = (h: number) => {
    const x = new Date(d);
    x.setUTCHours(h, 0, 0, 0);
    return x.toISOString();
  };
  return { startsAt: at(a), endsAt: at(b) };
};

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `RP${stamp}`.slice(0, 20), name: "Report Dept" })
    .returning();
  const [otherDept] = await db
    .insert(departments)
    .values({ code: `RQ${stamp}`.slice(0, 20), name: "Other Dept" })
    .returning();
  if (!dept || !otherDept) throw new Error("dept failed");
  ids.dept = dept.id;
  ids.otherDept = otherDept.id;

  await person("admin", "ADMIN");
  await person("faculty", "FACULTY", dept.id);
  await person("bystander", "FACULTY", dept.id);
  await person("senior", "HOD_DEAN", dept.id);
  await person("otherSenior", "HOD_DEAN", otherDept.id);

  const [club] = await db
    .insert(clubs)
    .values({
      name: `Report Club ${stamp}`,
      slug: `rep-club-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin,
    })
    .returning();
  if (!club) throw new Error("club failed");
  ids.club = club.id;
  await person("lead");
  await db.insert(clubMemberships).values([
    { clubId: club.id, userId: ids.lead as string, clubRole: "LEAD" },
    // The club's faculty member replaces the old advisor grant.
    { clubId: club.id, userId: ids.faculty as string, clubRole: "FACULTY" },
  ]);
  await person("outsiderLead");

  // A verified student who registers and attends.
  const email = `rep.student.${stamp}.${rnd()}@test.campusops.local`;
  const [student] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: "COLLEGE_STUDENT",
      status: "ACTIVE",
      fullName: "Report Student",
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!student) throw new Error("student failed");
  ids.student = student.id;
  await db.insert(studentProfiles).values({
    userId: student.id,
    studentKind: "COLLEGE_STUDENT" as const,
    rollNumber: `ROLL${stamp}`.slice(0, 20),
    departmentId: dept.id,
    institutionName: "Test College",
    verifiedBy: ids.faculty as string,
    verifiedAt: new Date(),
  });
});

/** Run an event all the way to COMPLETED with real approvals. */
async function completedEvent(offset: number) {
  const { db } = getDb();
  const w = win(offset);
  const created = await req(
    "POST",
    "/api/v1/events",
    {
      clubId: ids.club,
      title: `Report Event ${rnd()}`,
      description: "An event whose record must be filed accurately.",
      template: "WORKSHOP",
      audience: "COLLEGE_ONLY",
      admissionMode: "FCFS",
      capacity: 50,
      ...w,
      registrationOpensAt: win(offset - 5, 0, 1).startsAt,
      registrationClosesAt: w.startsAt,
      venueSummary: "Seminar Hall",
    },
    tokens.lead,
  );
  expect(created.status).toBe(201);
  const eventId = created.json.data.id as string;
  const sub = await req(
    "POST",
    `/api/v1/events/${eventId}/submit`,
    {
      expectedRevision: 1,
      requests: [
        { type: "ORGANIZE", title: "Permission to organize", assignedApproverId: ids.faculty },
      ],
    },
    tokens.lead,
  );
  expect(sub.status).toBe(200);
  const requestId = sub.json.data.requests[0].id;
  const dec = await req(
    "POST",
    `/api/v1/approval-requests/${requestId}/decision`,
    { action: "APPROVE", comment: "Approved for the department.", expectedVersion: 1 },
    tokens.faculty,
  );
  expect(dec.status).toBe(200);
  const pub = await req(
    "POST",
    `/api/v1/events/${eventId}/publish`,
    { expectedRevision: 1 },
    tokens.lead,
  );
  expect(pub.status).toBe(200);

  await db.insert(registrations).values({
    eventId,
    userId: ids.student as string,
    status: "CONFIRMED",
    admissionModeSnapshot: "FCFS",
    eligibilitySnapshot: { version: 1 },
    eventRevision: 1,
    confirmedAt: new Date(),
  });

  // Move the window into the past so completion is legal.
  await db
    .update(events)
    .set({
      registrationOpensAt: new Date(Date.now() - 14400_000),
      registrationClosesAt: new Date(Date.now() - 7200_000),
      startsAt: new Date(Date.now() - 7200_000),
      endsAt: new Date(Date.now() - 3600_000),
    })
    .where(eq(events.id, eventId));
  const done = await req("POST", `/api/v1/events/${eventId}/complete`, {}, tokens.lead);
  expect(done.status).toBe(200);
  return eventId;
}

describe("event reports", () => {
  test("a report captures permissions, club, coordinators, faculty and attendees", async () => {
    const eventId = await completedEvent(70);
    const gen = await req(
      "POST",
      `/api/v1/events/${eventId}/reports`,
      { notes: "Ran smoothly; projector was replaced mid-session." },
      tokens.lead,
    );
    expect(gen.status).toBe(201);
    const s = gen.json.data.snapshot;

    // Version 2 adds the Phase 7 on-the-day sections.
    expect(s.reportVersion).toBe(2);
    expect(s.access).toBeDefined();
    expect(s.issues).toBeDefined();
    expect(Array.isArray(s.announcements)).toBe(true);
    expect(s.event.title).toContain("Report Event");
    expect(s.event.status).toBe("COMPLETED");
    expect(s.club.name).toContain("Report Club");
    expect(s.club.department).toBe("Report Dept");

    // Who organized it.
    expect(s.organizers.map((o: Body) => o.fullName)).toContain("Report lead");
    expect(s.organizers[0].clubRole).toBe("LEAD");

    // By whose permission, with the full trail.
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0].finalStatus).toBe("APPROVED");
    expect(s.approvals[0].decidedBy.fullName).toBe("Report faculty");
    expect(s.approvals[0].trail.map((t: Body) => t.action)).toContain("APPROVE");

    // Which faculty were involved.
    expect(s.facultyInvolved.map((f: Body) => f.fullName)).toContain("Report faculty");

    // Who attended.
    expect(s.attendance.registered).toBe(1);
    expect(s.attendance.confirmed).toBe(1);
    expect(s.attendees).toHaveLength(1);
    expect(s.attendees[0].fullName).toBe("Report Student");
    expect(s.attendees[0].department).toBe("Report Dept");
    expect(s.attendees[0].rollNumber).toBeTruthy();

    // Attendance must not claim physical presence without QR data.
    expect(s.attendance.source).toBe("REGISTRATION_ONLY");
    expect(s.attendance.attendanceRatePercent).toBeNull();

    expect(s.notes).toContain("projector");
    expect(s.integrity.checksum).toMatch(/^[a-f0-9]{64}$/);
    ids.reportEvent = eventId;
    ids.report = gen.json.data.report.id;
  });

  test("the submitting coordinator is not misreported as faculty involved", async () => {
    const result = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports/${ids.report}`,
      undefined,
      tokens.lead,
    );
    const names = result.json.data.snapshot.facultyInvolved.map((f: Body) => f.fullName);
    // The lead only SUBMITTED; that is not faculty involvement.
    expect(names).not.toContain("Report lead");
    expect(names).toContain("Report faculty");
    // Every listed person must be a staff account.
    const { db } = getDb();
    for (const f of result.json.data.snapshot.facultyInvolved) {
      const [u] = await db.select().from(users).where(eq(users.id, f.id));
      expect(u?.accountType).toBe("STAFF");
    }
  });

  test("the issued PDF is a real, readable multi-section document", async () => {
    const res = await app.request(`/api/v1/events/${ids.reportEvent}/reports/${ids.report}/pdf`, {
      headers: { authorization: `Bearer ${tokens.lead}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(2000);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toContain("Event Report");
    expect(res.headers.get("x-report-checksum")).toMatch(/^[a-f0-9]{64}$/);
  });

  test("regenerating creates a new numbered version and never edits the old one", async () => {
    const first = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports/${ids.report}`,
      undefined,
      tokens.lead,
    );
    const second = await req(
      "POST",
      `/api/v1/events/${ids.reportEvent}/reports`,
      { notes: "Second filing with an added note." },
      tokens.lead,
    );
    expect(second.status).toBe(201);
    expect(second.json.data.report.sequence).toBe(2);
    const again = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports/${ids.report}`,
      undefined,
      tokens.lead,
    );
    expect(again.json.data.snapshot.notes).toBe(first.json.data.snapshot.notes);
    expect(again.json.data.integrity.verified).toBe(true);

    const list = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports`,
      undefined,
      tokens.lead,
    );
    expect(list.json.data.items.map((r: Body) => r.sequence)).toEqual([2, 1]);
  });

  test("the database refuses to rewrite an issued report", async () => {
    const { db } = getDb();
    await expect(
      (async () => {
        await db
          .update(eventReports)
          .set({ checksumSha256: "tampered" })
          .where(eq(eventReports.id, ids.report as string));
      })(),
    ).rejects.toThrow();
  });

  test("access is institutional, not open to any faculty or other departments", async () => {
    // Faculty who acted on the event: allowed.
    const involved = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports`,
      undefined,
      tokens.faculty,
    );
    expect(involved.status).toBe(200);
    // Admin and department HOD/Dean: allowed.
    for (const who of ["admin", "senior"]) {
      const r = await req(
        "GET",
        `/api/v1/events/${ids.reportEvent}/reports`,
        undefined,
        tokens[who],
      );
      expect(r.status).toBe(200);
    }
    // Faculty who never touched it: refused.
    const bystander = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports`,
      undefined,
      tokens.bystander,
    );
    expect(bystander.status).toBe(404);
    // HOD/Dean of another department: refused.
    const otherSenior = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports`,
      undefined,
      tokens.otherSenior,
    );
    expect(otherSenior.status).toBe(404);
    // A coordinator of an unrelated club: refused.
    const otherLead = await req(
      "POST",
      `/api/v1/events/${ids.reportEvent}/reports`,
      {},
      tokens.outsiderLead,
    );
    expect(otherLead.status).toBe(404);
    // The PDF must be protected too, not just the JSON.
    const pdf = await app.request(`/api/v1/events/${ids.reportEvent}/reports/${ids.report}/pdf`, {
      headers: { authorization: `Bearer ${tokens.bystander}` },
    });
    expect(pdf.status).toBe(404);
  });

  test("a report cannot be issued before the event finishes", async () => {
    const w = win(80);
    const created = await req(
      "POST",
      "/api/v1/events",
      {
        clubId: ids.club,
        title: `Future Event ${rnd()}`,
        description: "Not finished yet.",
        template: "SEMINAR",
        audience: "COLLEGE_ONLY",
        admissionMode: "FCFS",
        capacity: 10,
        ...w,
        registrationOpensAt: win(75, 0, 1).startsAt,
        registrationClosesAt: w.startsAt,
      },
      tokens.lead,
    );
    const early = await req(
      "POST",
      `/api/v1/events/${created.json.data.id}/reports`,
      {},
      tokens.lead,
    );
    expect(early.status).toBe(409);
    expect(early.json.error.message).toContain("not finished");
  });

  test("preview shows the same facts without filing a record", async () => {
    const before = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports`,
      undefined,
      tokens.lead,
    );
    const preview = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/report-preview`,
      undefined,
      tokens.lead,
    );
    expect(preview.status).toBe(200);
    expect(preview.json.data.preview).toBe(true);
    expect(preview.json.data.snapshot.attendees).toHaveLength(1);
    const after = await req(
      "GET",
      `/api/v1/events/${ids.reportEvent}/reports`,
      undefined,
      tokens.lead,
    );
    expect(after.json.data.items.length).toBe(before.json.data.items.length);
  });

  test("counts stay exact when the attendee list is capped", async () => {
    const { db } = getDb();
    const { env } = await import("../src/config/env");
    const eventId = await completedEvent(90);
    // Two more registrations beyond the one completedEvent creates.
    const extra: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [u] = await db
        .insert(users)
        .values({
          email: `rep.extra${i}.${stamp}.${rnd()}@test.campusops.local`,
          passwordHash: await hashPassword(PASSWORD),
          accountType: "OUTSIDER_STUDENT",
          status: "ACTIVE",
          fullName: `Extra Attendee ${i}`,
          emailVerifiedAt: new Date(),
        })
        .returning();
      if (!u) throw new Error("extra failed");
      extra.push(u.id);
      await db.insert(registrations).values({
        eventId,
        userId: u.id,
        status: i === 0 ? "WAITLISTED" : "CANCELLED",
        admissionModeSnapshot: "FCFS",
        eligibilitySnapshot: { version: 1 },
        eventRevision: 1,
      });
    }

    const original = env.REPORT_MAX_ATTENDEES;
    try {
      // Force a cap of 1 listed row against 3 real registrations.
      (env as { REPORT_MAX_ATTENDEES: number }).REPORT_MAX_ATTENDEES = 1;
      const gen = await req("POST", `/api/v1/events/${eventId}/reports`, {}, tokens.lead);
      expect(gen.status).toBe(201);
      const s = gen.json.data.snapshot;
      expect(s.attendees).toHaveLength(1);
      expect(s.attendeesTruncated).toBe(true);
      // The summary must still describe all three, not just the listed one.
      expect(s.attendance.registered).toBe(3);
      expect(s.attendance.confirmed).toBe(1);
      expect(s.attendance.waitlisted).toBe(1);
      expect(s.attendance.cancelled).toBe(1);
    } finally {
      (env as { REPORT_MAX_ATTENDEES: number }).REPORT_MAX_ATTENDEES = original;
    }
  });

  test("the on-the-day sections reconcile with the access log and complaint inbox", async () => {
    const eventId = await completedEvent(80);
    const preview = await req(
      "GET",
      `/api/v1/events/${eventId}/report-preview`,
      undefined,
      tokens.lead,
    );
    expect(preview.status).toBe(200);
    const s = preview.json.data.snapshot;
    // Every counter appears with its own totals, and the section totals are the
    // sum of the per-counter rows rather than an independent estimate.
    const granted = s.access.counters.reduce((a: number, c: Body) => a + c.granted, 0);
    const denied = s.access.counters.reduce((a: number, c: Body) => a + c.denied, 0);
    expect(s.access.totalGranted).toBe(granted);
    expect(s.access.totalDenied).toBe(denied);
    expect(
      s.access.identityChecks.match +
        s.access.identityChecks.mismatch +
        s.access.identityChecks.notRequired,
    ).toBeGreaterThanOrEqual(0);
    expect(s.issues.resolved + s.issues.open).toBe(s.issues.total);
    // No quiz on this event, so the section is explicitly null rather than zeros.
    expect(s.quiz).toBeNull();
  });

  test("storage being disabled is stated, not silently faked", async () => {
    const gen = await req("POST", `/api/v1/events/${ids.reportEvent}/reports`, {}, tokens.lead);
    expect(gen.status).toBe(201);
    // The test environment runs STORAGE_MODE=disabled.
    expect(gen.json.data.archived).toBe(false);
    expect(gen.json.data.archiveNote).toContain("not archived");
    // The PDF is still obtainable because it is re-rendered from the snapshot.
    const pdf = await app.request(
      `/api/v1/events/${ids.reportEvent}/reports/${gen.json.data.report.id}/pdf`,
      { headers: { authorization: `Bearer ${tokens.lead}` } },
    );
    expect(pdf.status).toBe(200);
  });
});
