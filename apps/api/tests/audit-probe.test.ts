import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  approvalRequests,
  clubMemberships,
  clubs,
  departments,
  resourceReservations,
  resourceUnits,
  resources,
  roleAssignments,
  staffProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/**
 * Adversarial audit probes. Each test asserts the behaviour the product promises,
 * not the behaviour the code happens to have. Failures here are real defects.
 */
const app = createApp();
const PASSWORD = "Audit-Probe-Password!";
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
  const email = `audit.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: "STAFF",
      status: "ACTIVE",
      fullName: `Audit ${label}`,
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

function draft(offset = 30) {
  const w = win(offset);
  return {
    clubId: ids.club,
    title: `Audit ${rnd()}`,
    description: "probe",
    template: "WORKSHOP",
    audience: "COLLEGE_ONLY",
    admissionMode: "FCFS",
    capacity: 30,
    ...w,
    registrationOpensAt: win(offset - 5, 0, 1).startsAt,
    registrationClosesAt: w.startsAt,
  };
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `AU${stamp}`.slice(0, 20), name: "Audit Dept" })
    .returning();
  if (!dept) throw new Error("dept failed");
  ids.dept = dept.id;
  await person("admin", "ADMIN");
  await person("faculty", "FACULTY", dept.id);
  await person("senior", "HOD_DEAN", dept.id);
  const [club] = await db
    .insert(clubs)
    .values({
      name: `Audit Club ${stamp}`,
      slug: `audit-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin,
    })
    .returning();
  if (!club) throw new Error("club failed");
  ids.club = club.id;
  await person("lead");
  await db
    .insert(clubMemberships)
    .values({ clubId: club.id, userId: ids.lead as string, clubRole: "LEAD" });
  const [res] = await db
    .insert(resources)
    .values({
      kind: "LAB",
      name: `Audit Lab ${stamp}`,
      code: `AU-LAB-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin,
    })
    .returning();
  if (!res) throw new Error("resource failed");
  const [unit] = await db
    .insert(resourceUnits)
    .values({ resourceId: res.id, label: "Audit Room", code: `AU-U-${stamp}` })
    .returning();
  if (!unit) throw new Error("unit failed");
  ids.unit = unit.id;
});

/** Create + submit an event with one organize and one resource request. */
async function submitted(offset: number) {
  const created = await req("POST", "/api/v1/events", draft(offset), tokens.lead);
  expect(created.status).toBe(201);
  const eventId = created.json.data.id as string;
  const w = win(offset);
  const sub = await req(
    "POST",
    `/api/v1/events/${eventId}/submit`,
    {
      expectedRevision: 1,
      requests: [
        { type: "ORGANIZE", title: "Organize probe", assignedApproverId: ids.faculty },
        {
          type: "RESOURCE_USE",
          title: "Lab probe",
          assignedApproverId: ids.faculty,
          resources: [{ resourceUnitId: ids.unit, ...w }],
        },
      ],
    },
    tokens.lead,
  );
  expect(sub.status).toBe(200);
  return { eventId, requests: sub.json.data.requests as Body[] };
}

async function approveAll(requests: Body[]) {
  for (const r of requests) {
    const d = await req(
      "POST",
      `/api/v1/approval-requests/${r.id}/decision`,
      { action: "APPROVE", expectedVersion: r.version ?? 1 },
      tokens.faculty,
    );
    expect(d.status).toBe(200);
  }
}

describe("audit: publish must not leave a resource merely HELD", () => {
  test("publishing confirms every reservation it validated", async () => {
    const { eventId, requests } = await submitted(40);
    await approveAll(requests);
    const pub = await req(
      "POST",
      `/api/v1/events/${eventId}/publish`,
      { expectedRevision: 1 },
      tokens.lead,
    );
    expect(pub.status).toBe(200);
    const { db } = getDb();
    const rows = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.eventId, eventId));
    expect(rows.length).toBeGreaterThan(0);
    // A published event must never depend on an expiring hold.
    for (const r of rows) expect(r.status).toBe("CONFIRMED");
  });
});

describe("audit: attachments after approval must not bypass re-approval", () => {
  test("resources cannot be attached to an already-approved request", async () => {
    const { eventId, requests } = await submitted(41);
    const resourceReq = requests.find((r) => r.type === "RESOURCE_USE") as Body;
    const d = await req(
      "POST",
      `/api/v1/approval-requests/${resourceReq.id}/decision`,
      { action: "APPROVE", expectedVersion: 1 },
      tokens.faculty,
    );
    expect(d.status).toBe(200);
    const after = d.json.data.request.version as number;
    // Approver agreed to Lab A. Attaching a different unit afterwards must not
    // silently inherit that approval.
    const attach = await req(
      "POST",
      `/api/v1/approval-requests/${resourceReq.id}/resources`,
      {
        expectedVersion: after,
        resources: [{ resourceUnitId: ids.unit, ...win(41, 14, 16) }],
      },
      tokens.lead,
    );
    expect([400, 409, 422]).toContain(attach.status);
    void eventId;
  });
});

describe("audit: adding a required approval re-locks a READY event", () => {
  test("a READY event returns to PENDING_APPROVALS when a required request is added", async () => {
    const { eventId, requests } = await submitted(42);
    await approveAll(requests);
    const bundle = await req(
      "GET",
      `/api/v1/events/${eventId}/approval-bundle`,
      undefined,
      tokens.lead,
    );
    expect(bundle.json.data.event.status).toBe("READY");
    const add = await req(
      "POST",
      `/api/v1/events/${eventId}/approval-requests`,
      {
        type: "CUSTOM",
        title: "Extra catering permission",
        isRequired: true,
        assignedApproverId: ids.faculty,
      },
      tokens.lead,
    );
    expect([200, 201]).toContain(add.status);
    const after = await req(
      "GET",
      `/api/v1/events/${eventId}/approval-bundle`,
      undefined,
      tokens.lead,
    );
    expect(after.json.data.event.status).toBe("PENDING_APPROVALS");
    expect(after.json.data.summary.readyToPublish).toBe(false);
  });
});

describe("audit: completed and cancelled events release everything", () => {
  test("cancelling a published event releases confirmed reservations", async () => {
    const { eventId, requests } = await submitted(43);
    await approveAll(requests);
    await req("POST", `/api/v1/events/${eventId}/publish`, { expectedRevision: 1 }, tokens.lead);
    const cancel = await req(
      "POST",
      `/api/v1/events/${eventId}/cancel`,
      { reason: "Audit cancellation probe." },
      tokens.lead,
    );
    expect(cancel.status).toBe(200);
    const { db } = getDb();
    const rows = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.eventId, eventId));
    for (const r of rows) expect(["RELEASED", "EXPIRED"]).toContain(r.status);
  });
});

describe("audit: outsiders cannot see college-only events", () => {
  test("a college-only published event is invisible to an outsider account", async () => {
    const { db } = getDb();
    const email = `audit.outsider.${stamp}.${rnd()}@test.campusops.local`;
    const [u] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(PASSWORD),
        accountType: "OUTSIDER_STUDENT",
        status: "ACTIVE",
        fullName: "Audit Outsider",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!u) throw new Error("outsider failed");
    const login = await req("POST", "/api/v1/auth/login", {
      email,
      password: PASSWORD,
      client: "mobile",
    });
    const token = login.json.data.accessToken as string;
    const { eventId, requests } = await submitted(44);
    await approveAll(requests);
    await req("POST", `/api/v1/events/${eventId}/publish`, { expectedRevision: 1 }, tokens.lead);
    const direct = await req("GET", `/api/v1/events/${eventId}`, undefined, token);
    expect(direct.status).toBe(404);
    const list = await req("GET", "/api/v1/events?limit=100", undefined, token);
    expect(list.json.data.items.map((e: Body) => e.id)).not.toContain(eventId);
    // Operational sub-resources must not leak either.
    for (const suffix of ["approval-bundle", "reservations", "audit", "revisions"]) {
      const r = await req("GET", `/api/v1/events/${eventId}/${suffix}`, undefined, token);
      expect([401, 403, 404]).toContain(r.status);
    }
  });
});

describe("audit: the event report contract is not a lie", () => {
  test("completeEvent does not accept a field it silently discards", async () => {
    const { eventId, requests } = await submitted(45);
    await approveAll(requests);
    await req("POST", `/api/v1/events/${eventId}/publish`, { expectedRevision: 1 }, tokens.lead);
    const { db } = getDb();
    // Force the event into the past so completion is legal.
    await db
      .update(events)
      .set({
        registrationOpensAt: new Date(Date.now() - 14400_000),
        registrationClosesAt: new Date(Date.now() - 7200_000),
        startsAt: new Date(Date.now() - 7200_000),
        endsAt: new Date(Date.now() - 3600_000),
      })
      .where(eq(events.id, eventId));
    const bogus = "00000000-0000-4000-8000-0000000000ff";
    const done = await req(
      "POST",
      `/api/v1/events/${eventId}/complete`,
      { reportFileId: bogus },
      tokens.lead,
    );
    // Reports are generated server-side, so an uploaded reference is refused
    // outright rather than accepted and discarded.
    expect(done.status).toBe(400);
    const clean = await req("POST", `/api/v1/events/${eventId}/complete`, {}, tokens.lead);
    expect(clean.status).toBe(200);
    expect(clean.json.data.status).toBe("COMPLETED");
  });
});

afterAll(async () => {
  // Audit rows are append-only; leave the trail intact by design.
  const { sql } = getDb();
  void sql;
  void approvalRequests;
});

describe("audit: documented contracts match runtime behaviour", () => {
  test("OpenAPI advertises the pagination style the routes actually accept", async () => {
    const { operations } = await import("../src/openapi/manifest");
    for (const path of ["/faculty/verification-queue", "/clubs"]) {
      const op = operations.find((o) => o.path === path && o.method === "get");
      expect(op).toBeDefined();
      const shape = (op?.query as unknown as { shape: Record<string, unknown> })?.shape ?? {};
      // offset is implemented; a cursor is not, so it must not be advertised.
      expect(Object.keys(shape)).toContain("offset");
      expect(Object.keys(shape)).not.toContain("cursor");
    }
  });

  test("event banners can actually be presigned, since events require that purpose", async () => {
    const res = await req(
      "POST",
      "/api/v1/files/presign",
      { purpose: "EVENT_BANNER", mimeType: "image/png", sizeBytes: 4096 },
      tokens.lead,
    );
    // Storage is disabled in tests: the gate must reject for STORAGE, not purpose.
    expect(res.json.error?.code).toBe("STORAGE_DISABLED");
  });

  test("server-generated report purposes are refused for direct upload", async () => {
    const res = await req(
      "POST",
      "/api/v1/files/presign",
      { purpose: "EVENT_REPORT", mimeType: "application/pdf", sizeBytes: 4096 },
      tokens.lead,
    );
    expect(res.status).toBe(403);
    expect(res.json.error.message).toContain("generated by the server");
  });

  test("operational caps come from configuration, not literals", async () => {
    const { env } = await import("../src/config/env");
    for (const key of [
      "OUTBOX_FANOUT_MAX",
      "INVITATION_LIST_MAX",
      "RESOURCE_AVAILABILITY_MAX_UNITS",
      "APPROVER_DIRECTORY_MAX",
      "QR_TTL_SECONDS",
    ] as const) {
      expect(typeof env[key]).toBe("number");
      expect(env[key]).toBeGreaterThan(0);
    }
  });
});
