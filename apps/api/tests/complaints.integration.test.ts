import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFArray, PDFDocument, PDFName, type PDFRawStream, decodePDFRawStream } from "pdf-lib";
import QRCode from "qrcode";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { getDb } from "../src/db/client";
import {
  events,
  clubMemberships,
  clubs,
  departments,
  registrations,
  roleAssignments,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { renderComplaintPoster } from "../src/modules/complaints/poster";
import { hashPassword } from "../src/utils/password";

const app = createApp();
const PASSWORD = "Complaint-Test-Password!";
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
  const email = `cmp.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: kind === "staff" ? "STAFF" : "COLLEGE_STUDENT",
      status: "ACTIVE",
      fullName: `Complaint ${label}`,
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
      rollNumber: `CP${stamp}${rnd()}`.slice(0, 20),
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
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `CP${stamp}`.slice(0, 20), name: "Complaint Dept" })
    .returning();
  if (!dept) throw new Error("dept failed");
  ids.dept = dept.id;

  await account("admin", "staff", "ADMIN");
  await account("lead", "staff");
  await account("coordinator", "staff");
  await account("faculty", "staff", "FACULTY");
  await account("outsiderStaff", "staff", "FACULTY");
  await account("attendee", "student");
  await account("nonAttendee", "student");
  await account("otherAttendee", "student");

  const [club] = await db
    .insert(clubs)
    .values({
      name: `Aarohan Cultural Club ${stamp}`,
      slug: `cmp-club-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin as string,
    })
    .returning();
  const [otherClub] = await db
    .insert(clubs)
    .values({
      name: `Unrelated Club ${stamp}`,
      slug: `cmp-other-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin as string,
    })
    .returning();
  if (!club || !otherClub) throw new Error("club failed");
  ids.club = club.id;
  ids.otherClub = otherClub.id;
  await db.insert(clubMemberships).values([
    { clubId: club.id, userId: ids.lead as string, clubRole: "LEAD" },
    { clubId: club.id, userId: ids.coordinator as string, clubRole: "COORDINATOR" },
    { clubId: club.id, userId: ids.faculty as string, clubRole: "FACULTY" },
    { clubId: otherClub.id, userId: ids.outsiderStaff as string, clubRole: "LEAD" },
  ]);
  ids.clubName = club.name;

  async function makeEvent(clubId: string, title: string) {
    const starts = new Date(Date.now() - 3_600_000);
    const [e] = await db
      .insert(events)
      .values({
        clubId,
        title,
        slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}-${rnd()}`,
        description: "An event with reporting points on the ground.",
        template: "CUSTOM",
        audience: "COLLEGE_ONLY",
        admissionMode: "FCFS",
        capacity: 100,
        startsAt: starts,
        endsAt: new Date(Date.now() + 8 * 3_600_000),
        registrationOpensAt: new Date(Date.now() - 10 * 86_400_000),
        registrationClosesAt: starts,
        venueSummary: "Open Air Theatre",
        status: "LIVE",
        publishedAt: new Date(Date.now() - 86_400_000),
        createdBy: ids.lead as string,
      })
      .returning();
    if (!e) throw new Error("event failed");
    return e;
  }

  const event = await makeEvent(club.id, "Spring Fest Day One");
  ids.event = event.id;
  ids.eventTitle = event.title;
  const other = await makeEvent(otherClub.id, "Other Club Meet");
  ids.otherEvent = other.id;

  for (const label of ["attendee", "otherAttendee"]) {
    await db.insert(registrations).values({
      eventId: event.id,
      userId: ids[label] as string,
      status: "CONFIRMED",
      admissionModeSnapshot: "FCFS",
      eligibilitySnapshot: { version: 1 },
      eventRevision: 1,
      confirmedAt: new Date(),
    });
  }
});

/**
 * pdf-lib compresses page content and may split it across several streams, so
 * inflate and concatenate before asserting on what a poster actually paints.
 */
function posterOperators(doc: PDFDocument): string {
  const resolved = doc.context.lookup(doc.getPage(0).node.get(PDFName.of("Contents")));
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [resolved];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref) as PDFRawStream;
      const operators = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
      // pdf-lib writes text as hex strings; decode them so assertions can read
      // the words the poster actually prints.
      return operators.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_m, hex: string) =>
        Buffer.from(hex, "hex").toString("latin1"),
      );
    })
    .join("\n");
}

async function location(label: string, over: Body = {}) {
  const res = await req(
    "POST",
    `/api/v1/events/${ids.event}/complaint-locations`,
    { label, ...over },
    tokens.coordinator,
  );
  expect(res.status).toBe(201);
  return res.json.data as Body;
}

describe("complaint reporting points", () => {
  test("a coordinator creates reporting points, including an ad-hoc spot", async () => {
    const stage = await location("Main stage sound desk", {
      description: "Beside the mixing console, stage left.",
    });
    const food = await location("Food counter");
    const adhoc = await location("Corner by the gate");
    ids.stage = stage.id;
    ids.food = food.id;
    expect(stage.revokedAt).toBeNull();
    const list = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaint-locations`,
      undefined,
      tokens.lead,
    );
    expect(list.status).toBe(200);
    expect(list.json.data.items).toHaveLength(3);
    expect(list.json.data.items[0].open).toBe(0);
    expect(adhoc.id).toBeTruthy();
  });

  test("a label cannot repeat within the event", async () => {
    const res = await req(
      "POST",
      `/api/v1/events/${ids.event}/complaint-locations`,
      { label: "Food counter" },
      tokens.coordinator,
    );
    expect(res.status).toBe(409);
  });

  test("someone outside the event's club cannot create or read its points", async () => {
    const create = await req(
      "POST",
      `/api/v1/events/${ids.event}/complaint-locations`,
      { label: "Intruder point" },
      tokens.outsiderStaff,
    );
    expect(create.status).toBe(403);
    const read = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaint-locations`,
      undefined,
      tokens.outsiderStaff,
    );
    // Not 403: the event's private records must not be discoverable at all.
    expect(read.status).toBe(404);
    const patch = await req(
      "PATCH",
      `/api/v1/complaints/locations/${ids.food}`,
      { label: "Renamed by an outsider" },
      tokens.outsiderStaff,
    );
    expect(patch.status).toBe(403);
  });

  test("the club's faculty may download the poster but not reconfigure points", async () => {
    const poster = await app.request(`/api/v1/complaints/locations/${ids.stage}/poster`, {
      headers: { authorization: `Bearer ${tokens.faculty}` },
    });
    expect(poster.status).toBe(200);
    const create = await req(
      "POST",
      `/api/v1/events/${ids.event}/complaint-locations`,
      { label: "Faculty point" },
      tokens.faculty,
    );
    expect(create.status).toBe(403);
  });
});

describe("the downloadable complaint QR", () => {
  test("the poster is a real one-page PDF offered as an attachment", async () => {
    const res = await app.request(`/api/v1/complaints/locations/${ids.stage}/poster`, {
      headers: { authorization: `Bearer ${tokens.lead}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(2000);
  });

  test("the download carries the club, the event and the location", async () => {
    const bytes = await renderComplaintPoster({
      qrPayload: `${env.COMPLAINT_QR_BASE}/probe`,
      clubName: "Aarohan Cultural Club",
      eventTitle: "Spring Fest Day One",
      eventWhen: "1 Nov 2026, 10:00 am",
      locationLabel: "Main stage sound desk",
      locationDescription: "Beside the mixing console.",
      reference: "ABCD1234",
    });
    const doc = await PDFDocument.load(bytes);
    const operators = posterOperators(doc);
    expect(operators).toContain("Aarohan Cultural Club");
    expect(operators).toContain("Spring Fest Day One");
    expect(operators).toContain("Main stage sound desk");
    expect(operators).toContain("Beside the mixing console.");
    expect(operators).toContain("ABCD1234");
    expect(operators).toContain("Report an issue here");
    // The QR is painted as filled modules, not left as an empty frame.
    expect((operators.match(/\bf\n/g) ?? []).length).toBeGreaterThan(100);
    expect(doc.getTitle()).toContain("Spring Fest Day One");
  });

  test("the served poster names the real event, club and location", async () => {
    const res = await app.request(`/api/v1/complaints/locations/${ids.stage}/poster`, {
      headers: { authorization: `Bearer ${tokens.coordinator}` },
    });
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    const operators = posterOperators(doc);
    expect(operators).toContain(String(ids.clubName).replace(/ \d+$/, ""));
    expect(operators).toContain("Spring Fest Day One");
    expect(operators).toContain("Main stage sound desk");
    expect(operators).toContain(String(ids.stage).slice(0, 8).toUpperCase());
  });

  test("the printed modules decode back to this location's deep link", async () => {
    // Reconstruct the QR grid from the PDF's own drawing commands and compare it
    // with the encoder's matrix for the expected payload. This proves the poster
    // on the wall points at this exact reporting point, not just "a QR".
    const res = await app.request(`/api/v1/complaints/locations/${ids.stage}/poster`, {
      headers: { authorization: `Bearer ${tokens.coordinator}` },
    });
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    const raw = doc.context.lookup(doc.getPage(0).node.get(PDFName.of("Contents")));
    const refs = raw instanceof PDFArray ? raw.asArray() : [raw];
    const operators = refs
      .map((r) =>
        Buffer.from(decodePDFRawStream(doc.context.lookup(r) as PDFRawStream).decode()).toString(
          "latin1",
        ),
      )
      .join("\n");

    const origins = [...operators.matchAll(/0 w\n\[\] 0 d\n1 0 0 1 ([\d.]+) ([\d.]+) cm/g)].map(
      (m) => ({ x: Number(m[1]), y: Number(m[2]) }),
    );
    expect(origins.length).toBeGreaterThan(100);
    const xs = [...new Set(origins.map((o) => o.x))].sort((a, b) => a - b);
    const ys = [...new Set(origins.map((o) => o.y))].sort((a, b) => a - b);
    const step = (values: number[]) =>
      Math.min(...values.slice(1).map((v, i) => v - (values[i] as number)));
    const cell = Math.min(step(xs), step(ys));
    const baseX = xs[0] as number;
    const baseY = ys[0] as number;

    const payload = `${env.COMPLAINT_QR_BASE}/${String(ids.stage)}`;
    const matrix = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
    const drawn = new Set(
      origins.map(
        (o) =>
          `${Math.round((o.x - baseX) / cell)},${matrix.size - 1 - Math.round((o.y - baseY) / cell)}`,
      ),
    );
    const expected = new Set<string>();
    for (let row = 0; row < matrix.size; row++) {
      for (let col = 0; col < matrix.size; col++) {
        if (matrix.get(row, col)) expected.add(`${col},${row}`);
      }
    }
    expect(drawn.size).toBe(expected.size);
    for (const key of expected) expect(drawn.has(key)).toBe(true);
  });

  test("the encoded link is the app deep link for that exact location", async () => {
    const resolved = await req(
      "GET",
      `/api/v1/complaints/locations/${ids.stage}`,
      undefined,
      tokens.attendee,
    );
    expect(resolved.status).toBe(200);
    expect(resolved.json.data.location.label).toBe("Main stage sound desk");
    expect(resolved.json.data.event.title).toBe(ids.eventTitle);
    expect(resolved.json.data.club.name).toBe(ids.clubName);
    expect(env.COMPLAINT_QR_BASE).toMatch(/^campusops:\/\//);
  });

  test("a closed reporting point stops new reports but keeps its history", async () => {
    const adhoc = await location("Temporary stall");
    const close = await req(
      "PATCH",
      `/api/v1/complaints/locations/${adhoc.id}`,
      { revoked: true },
      tokens.coordinator,
    );
    expect(close.status).toBe(200);
    expect(close.json.data.revokedAt).toBeTruthy();
    const resolve = await req(
      "GET",
      `/api/v1/complaints/locations/${adhoc.id}`,
      undefined,
      tokens.attendee,
    );
    expect(resolve.status).toBe(409);
    const report = await req(
      "POST",
      `/api/v1/complaints/locations/${adhoc.id}/reports`,
      { category: "POWER", description: "The extension board is sparking." },
      tokens.attendee,
    );
    expect(report.status).toBe(409);
    // Reopening is possible if the spot comes back into use.
    const reopen = await req(
      "PATCH",
      `/api/v1/complaints/locations/${adhoc.id}`,
      { revoked: false },
      tokens.coordinator,
    );
    expect(reopen.json.data.revokedAt).toBeNull();
  });
});

describe("raising and handling issues", () => {
  test("an attendee reports an issue and it appears in the event inbox", async () => {
    const raised = await req(
      "POST",
      `/api/v1/complaints/locations/${ids.stage}/reports`,
      { category: "EQUIPMENT", description: "The left speaker cuts out every few minutes." },
      tokens.attendee,
    );
    expect(raised.status).toBe(201);
    expect(raised.json.data.status).toBe("OPEN");
    ids.complaint = raised.json.data.id;

    const inbox = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaints`,
      undefined,
      tokens.coordinator,
    );
    expect(inbox.status).toBe(200);
    const item = inbox.json.data.items.find((i: Body) => i.id === ids.complaint);
    expect(item.reporter.fullName).toBe("Complaint attendee");
    expect(item.locationLabel).toBe("Main stage sound desk");
    expect(item.description).toContain("left speaker");
  });

  test("a student who is not attending cannot report against the event", async () => {
    const res = await req(
      "POST",
      `/api/v1/complaints/locations/${ids.stage}/reports`,
      { category: "OTHER", description: "I am not even at this event." },
      tokens.nonAttendee,
    );
    expect(res.status).toBe(403);
  });

  test("an organiser may report a problem they spot themselves", async () => {
    const res = await req(
      "POST",
      `/api/v1/complaints/locations/${ids.food}/reports`,
      { category: "SAFETY", description: "Queue is blocking the fire exit." },
      tokens.lead,
    );
    expect(res.status).toBe(201);
    ids.safety = res.json.data.id;
  });

  test("the inbox is scoped to the event, never institution-wide", async () => {
    const other = await req(
      "GET",
      `/api/v1/events/${ids.otherEvent}/complaints`,
      undefined,
      tokens.outsiderStaff,
    );
    expect(other.status).toBe(200);
    expect(other.json.data.items).toHaveLength(0);
    const denied = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaints`,
      undefined,
      tokens.outsiderStaff,
    );
    expect(denied.status).toBe(404);
    const direct = await req(
      "GET",
      `/api/v1/complaints/${ids.complaint}`,
      undefined,
      tokens.outsiderStaff,
    );
    // Not "forbidden": the complaint must not even be discoverable.
    expect(direct.status).toBe(404);
  });

  test("counts per location and per status are correct", async () => {
    const summary = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaints/summary`,
      undefined,
      tokens.lead,
    );
    expect(summary.status).toBe(200);
    expect(summary.json.data.byStatus.OPEN).toBe(2);
    expect(summary.json.data.activeLocations).toBeGreaterThanOrEqual(4);
    const list = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaint-locations`,
      undefined,
      tokens.lead,
    );
    const stage = list.json.data.items.find((i: Body) => i.id === ids.stage);
    expect(stage.total).toBe(1);
    expect(stage.open).toBe(1);
  });

  test("the reporter can follow their own issue but cannot resolve it", async () => {
    const mine = await req(
      "GET",
      `/api/v1/complaints/${ids.complaint}`,
      undefined,
      tokens.attendee,
    );
    expect(mine.status).toBe(200);
    expect(mine.json.data.updates).toHaveLength(1);
    const notMine = await req(
      "GET",
      `/api/v1/complaints/${ids.complaint}`,
      undefined,
      tokens.otherAttendee,
    );
    expect(notMine.status).toBe(404);
    const act = await req(
      "PATCH",
      `/api/v1/complaints/${ids.complaint}`,
      { status: "RESOLVED" },
      tokens.attendee,
    );
    expect(act.status).toBe(404);
  });

  test("assigning and resolving leaves a full handling trail", async () => {
    const assign = await req(
      "PATCH",
      `/api/v1/complaints/${ids.complaint}`,
      { status: "ASSIGNED", assignedTo: ids.coordinator, note: "Sound volunteer on the way." },
      tokens.lead,
    );
    expect(assign.status).toBe(200);
    expect(assign.json.data.assignedTo).toBe(ids.coordinator);
    const progress = await req(
      "PATCH",
      `/api/v1/complaints/${ids.complaint}`,
      { status: "IN_PROGRESS", note: "Replacing the cable." },
      tokens.coordinator,
    );
    expect(progress.status).toBe(200);
    const done = await req(
      "PATCH",
      `/api/v1/complaints/${ids.complaint}`,
      { status: "RESOLVED", note: "Cable replaced and tested." },
      tokens.faculty,
    );
    expect(done.status).toBe(200);
    expect(done.json.data.resolvedAt).toBeTruthy();

    const detail = await req(
      "GET",
      `/api/v1/complaints/${ids.complaint}`,
      undefined,
      tokens.attendee,
    );
    const updates = detail.json.data.updates as Body[];
    expect(updates).toHaveLength(4);
    expect(updates[0]?.update.toStatus).toBe("RESOLVED");
    expect(updates[0]?.actor.fullName).toBe("Complaint faculty");
    expect(updates[0]?.update.note).toBe("Cable replaced and tested.");
  });

  test("the inbox filters by status and location", async () => {
    const resolved = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaints?status=RESOLVED`,
      undefined,
      tokens.lead,
    );
    const items = resolved.json.data.items as Body[];
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(ids.complaint);
    const byLocation = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaints?locationId=${ids.food}`,
      undefined,
      tokens.lead,
    );
    expect(byLocation.json.data.items).toHaveLength(1);
    expect(byLocation.json.data.items[0].id).toBe(ids.safety);
  });

  test("resolved issues drop out of the open count", async () => {
    const list = await req(
      "GET",
      `/api/v1/events/${ids.event}/complaint-locations`,
      undefined,
      tokens.lead,
    );
    const stage = list.json.data.items.find((i: Body) => i.id === ids.stage);
    expect(stage.total).toBe(1);
    expect(stage.open).toBe(0);
  });

  test("assigning to a non-existent person is refused", async () => {
    const res = await req(
      "PATCH",
      `/api/v1/complaints/${ids.safety}`,
      { assignedTo: crypto.randomUUID() },
      tokens.lead,
    );
    expect(res.status).toBe(404);
  });

  test("an issue cannot be assigned to someone who cannot open it", async () => {
    const res = await req(
      "PATCH",
      `/api/v1/complaints/${ids.safety}`,
      { assignedTo: ids.outsiderStaff },
      tokens.lead,
    );
    expect(res.status).toBe(400);
    // An organiser of this event is a valid assignee.
    const ok = await req(
      "PATCH",
      `/api/v1/complaints/${ids.safety}`,
      { assignedTo: ids.faculty, status: "ASSIGNED", note: "Please marshalling the queue." },
      tokens.lead,
    );
    expect(ok.status).toBe(200);
  });

  test("a non-member cannot resolve reports just by knowing their id", async () => {
    const mine = await req("GET", "/api/v1/me/complaints", undefined, tokens.attendee);
    expect(mine.status).toBe(200);
    expect(mine.json.data.items.some((r: { id: string }) => r.id === ids.complaint)).toBe(true);
    const denied = await req(
      "PATCH",
      `/api/v1/complaints/${ids.complaint}`,
      { status: "RESOLVED" },
      tokens.nonAttendee,
    );
    expect(denied.status).toBe(404); // assertMayReport hides the event from non-participants
  });

  test("the audit trail records complaint handling", async () => {
    const { db } = getDb();
    const { auditLogs } = await import("../src/db/schema");
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "COMPLAINT_UPDATED"));
    // Assign, in-progress and resolved: one audited action each.
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});
