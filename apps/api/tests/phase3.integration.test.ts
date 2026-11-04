import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  approvalActions,
  approvalBundles,
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

const app = createApp();
const PASSWORD = "Phase3-Test-Password!";
const stamp = Date.now();
const rnd = () => Math.random().toString(36).slice(2, 8);

// Test responses are dynamic JSON; a single documented escape hatch keeps the
// assertions readable without weakening types in production code.
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

/** Create an ACTIVE staff user directly, then log in through the real API. */
async function makeStaff(
  label: string,
  role: "ADMIN" | "FACULTY" | "HOD_DEAN",
  departmentId: string | null,
  scope: "GLOBAL" | "DEPARTMENT" = "DEPARTMENT",
) {
  const { db } = getDb();
  const email = `p3.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: "STAFF",
      status: "ACTIVE",
      fullName: `P3 ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("staff insert failed");
  await db.insert(staffProfiles).values({ userId: user.id, departmentId, designation: label });
  await db.insert(roleAssignments).values({
    userId: user.id,
    role,
    scopeType: scope,
    departmentId: scope === "DEPARTMENT" ? departmentId : null,
  });
  const login = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  tokens[label] = login.json.data.accessToken;
  ids[label] = user.id;
  return user.id;
}

async function makeCoordinator(label: string, clubId: string, clubRole: "LEAD" | "COORDINATOR") {
  const { db } = getDb();
  const email = `p3.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: "STAFF",
      status: "ACTIVE",
      fullName: `P3 ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("coordinator insert failed");
  await db.insert(clubMemberships).values({ clubId, userId: user.id, clubRole });
  const login = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  tokens[label] = login.json.data.accessToken;
  ids[label] = user.id;
  return user.id;
}

const window = (dayOffset: number, startHour: number, endHour: number) => {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + dayOffset);
  const at = (h: number) => {
    const d = new Date(day);
    d.setUTCHours(h, 0, 0, 0);
    return d.toISOString();
  };
  return { startsAt: at(startHour), endsAt: at(endHour) };
};

function eventBody(clubId: string, dayOffset = 20) {
  const w = window(dayOffset, 9, 12);
  return {
    clubId,
    title: `Phase 3 Workshop ${rnd()}`,
    description: "Integration test event",
    template: "WORKSHOP",
    audience: "COLLEGE_ONLY",
    admissionMode: "FCFS",
    capacity: 40,
    ...w,
    registrationOpensAt: window(dayOffset - 5, 0, 1).startsAt,
    registrationClosesAt: w.startsAt,
    venueSummary: "Lab 2",
  };
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `P3A${stamp}`.slice(0, 20), name: "Phase 3 Dept A" })
    .returning();
  const [deptB] = await db
    .insert(departments)
    .values({ code: `P3B${stamp}`.slice(0, 20), name: "Phase 3 Dept B" })
    .returning();
  if (!dept || !deptB) throw new Error("dept insert failed");
  ids.dept = dept.id;
  ids.deptB = deptB.id;

  await makeStaff("admin", "ADMIN", null, "GLOBAL");
  await makeStaff("faculty", "FACULTY", dept.id);
  await makeStaff("faculty2", "FACULTY", dept.id);
  await makeStaff("otherFaculty", "FACULTY", deptB.id);
  await makeStaff("senior", "HOD_DEAN", dept.id);
  await makeStaff("otherSenior", "HOD_DEAN", deptB.id);

  const [club] = await db
    .insert(clubs)
    .values({
      name: `P3 Club ${stamp}`,
      slug: `p3-club-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin,
    })
    .returning();
  const [clubB] = await db
    .insert(clubs)
    .values({
      name: `P3 Club B ${stamp}`,
      slug: `p3-club-b-${stamp}`,
      departmentId: deptB.id,
      createdBy: ids.admin,
    })
    .returning();
  if (!club || !clubB) throw new Error("club insert failed");
  ids.club = club.id;
  ids.clubB = clubB.id;
  await makeCoordinator("lead", club.id, "LEAD");
  await makeCoordinator("coord", club.id, "COORDINATOR");
  await makeCoordinator("otherLead", clubB.id, "LEAD");

  const [resource] = await db
    .insert(resources)
    .values({
      kind: "LAB",
      name: `P3 Lab ${stamp}`,
      code: `P3-LAB-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin,
    })
    .returning();
  if (!resource) throw new Error("resource insert failed");
  ids.resource = resource.id;
  const unitRows = await db
    .insert(resourceUnits)
    .values([
      { resourceId: resource.id, label: "Room 1", code: `P3-U1-${stamp}` },
      { resourceId: resource.id, label: "Room 2", code: `P3-U2-${stamp}` },
    ])
    .returning();
  ids.unit1 = unitRows[0]?.id as string;
  ids.unit2 = unitRows[1]?.id as string;
});

describe("phase 3 events", () => {
  test("coordinator creates a draft; non-member cannot create in that club", async () => {
    const created = await req("POST", "/api/v1/events", eventBody(ids.club as string), tokens.lead);
    expect(created.status).toBe(201);
    expect(created.json.data.status).toBe("DRAFT");
    expect(created.json.data.currentRevision).toBe(1);
    ids.event = created.json.data.id;

    const forbidden = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string),
      tokens.otherLead,
    );
    expect(forbidden.status).toBe(403);
  });

  test("draft edits are revision-guarded and window-validated", async () => {
    const stale = await req(
      "PATCH",
      `/api/v1/events/${ids.event}`,
      { expectedRevision: 99, capacity: 50 },
      tokens.lead,
    );
    expect(stale.status).toBe(409);

    const bad = await req(
      "PATCH",
      `/api/v1/events/${ids.event}`,
      { expectedRevision: 1, endsAt: window(20, 8, 9).startsAt },
      tokens.lead,
    );
    expect(bad.status).toBe(422);

    const good = await req(
      "PATCH",
      `/api/v1/events/${ids.event}`,
      { expectedRevision: 1, capacity: 55, description: "Updated" },
      tokens.lead,
    );
    expect(good.status).toBe(200);
    expect(good.json.data.capacity).toBe(55);
  });

  test("submit freezes a revision and creates individual requests with holds", async () => {
    const w = window(20, 9, 12);
    const submit = await req(
      "POST",
      `/api/v1/events/${ids.event}/submit`,
      {
        expectedRevision: 1,
        requests: [
          {
            type: "ORGANIZE",
            title: "Organize workshop",
            assignedApproverId: ids.faculty,
            isRequired: true,
          },
          {
            type: "RESOURCE_USE",
            title: "Use Lab Room 1",
            assignedApproverId: ids.faculty,
            isRequired: true,
            resources: [{ resourceUnitId: ids.unit1, ...w }],
          },
          {
            type: "CUSTOM",
            title: "Refreshments",
            assignedApproverId: ids.faculty,
            isRequired: false,
          },
        ],
      },
      tokens.lead,
    );
    expect(submit.status).toBe(200);
    expect(submit.json.data.event.status).toBe("PENDING_APPROVALS");
    expect(submit.json.data.requests).toHaveLength(3);
    expect(submit.json.data.summary.required).toBe(2);
    ids.bundle = submit.json.data.bundle.id;
    ids.organizeRequest = submit.json.data.requests.find((r: Body) => r.type === "ORGANIZE").id;
    ids.resourceRequest = submit.json.data.requests.find((r: Body) => r.type === "RESOURCE_USE").id;
    ids.optionalRequest = submit.json.data.requests.find((r: Body) => r.type === "CUSTOM").id;

    const { db } = getDb();
    const holds = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.requestId, ids.resourceRequest as string));
    expect(holds).toHaveLength(1);
    expect(holds[0]?.status).toBe("HELD");
    expect(holds[0]?.holdExpiresAt).not.toBeNull();

    // A submitted event is frozen.
    const frozen = await req(
      "PATCH",
      `/api/v1/events/${ids.event}`,
      { expectedRevision: 1, capacity: 60 },
      tokens.lead,
    );
    expect(frozen.status).toBe(409);
  });

  test("overlapping resource request for the same unit fails with RESOURCE_CONFLICT", async () => {
    const other = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 20),
      tokens.lead,
    );
    ids.otherEvent = other.json.data.id;
    const w = window(20, 10, 11);
    const submit = await req(
      "POST",
      `/api/v1/events/${ids.otherEvent}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize second event", assignedApproverId: ids.faculty },
          {
            type: "RESOURCE_USE",
            title: "Use same lab",
            assignedApproverId: ids.faculty,
            resources: [{ resourceUnitId: ids.unit1, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    expect(submit.status).toBe(409);
    expect(submit.json.error.code).toBe("RESOURCE_CONFLICT");

    // The failed submission must not leave a partial bundle behind.
    const { db } = getDb();
    const [row] = await db
      .select()
      .from(events)
      .where(eq(events.id, ids.otherEvent as string));
    expect(row?.status).toBe("DRAFT");
    const bundles = await db
      .select()
      .from(approvalBundles)
      .where(eq(approvalBundles.eventId, ids.otherEvent as string));
    expect(bundles).toHaveLength(0);
  });

  test("adjacent window on the same unit is allowed", async () => {
    const w = window(20, 12, 14);
    const created = await req(
      "POST",
      "/api/v1/events",
      { ...eventBody(ids.club as string, 20), ...w, registrationClosesAt: w.startsAt },
      tokens.lead,
    );
    const eventId = created.json.data.id;
    const submit = await req(
      "POST",
      `/api/v1/events/${eventId}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize adjacent event", assignedApproverId: ids.faculty },
          {
            type: "RESOURCE_USE",
            title: "Use lab after",
            assignedApproverId: ids.faculty,
            resources: [{ resourceUnitId: ids.unit1, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    expect(submit.status).toBe(200);
    ids.adjacentEvent = eventId;
  });

  test("publish is blocked while required approvals are pending", async () => {
    const r = await req(
      "POST",
      `/api/v1/events/${ids.event}/publish`,
      { expectedRevision: 1 },
      tokens.lead,
    );
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("APPROVAL_REQUIRED");
  });

  test("only the assigned faculty can decide; stale versions are rejected", async () => {
    const wrong = await req(
      "POST",
      `/api/v1/approval-requests/${ids.organizeRequest}/decision`,
      { action: "APPROVE", expectedVersion: 1 },
      tokens.otherFaculty,
    );
    expect(wrong.status).toBe(403);

    const adminShortcut = await req(
      "POST",
      `/api/v1/approval-requests/${ids.organizeRequest}/decision`,
      { action: "APPROVE", expectedVersion: 1 },
      tokens.admin,
    );
    expect(adminShortcut.status).toBe(403);

    const stale = await req(
      "POST",
      `/api/v1/approval-requests/${ids.organizeRequest}/decision`,
      { action: "APPROVE", expectedVersion: 42 },
      tokens.faculty,
    );
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("STALE_APPROVAL_VERSION");

    const okRes = await req(
      "POST",
      `/api/v1/approval-requests/${ids.organizeRequest}/decision`,
      { action: "APPROVE", comment: "Looks good", expectedVersion: 1 },
      tokens.faculty,
    );
    expect(okRes.status).toBe(200);
    expect(okRes.json.data.request.status).toBe("APPROVED");
    expect(okRes.json.data.request.version).toBe(2);

    // Oversight can read the decision trail without being able to act on it.
    const trail = await req(
      "GET",
      `/api/v1/events/${ids.event}/approval-bundle`,
      undefined,
      tokens.senior,
    );
    expect(trail.status).toBe(200);
    expect(trail.json.data.history).toHaveLength(4);
    const approval = trail.json.data.history.find(
      (entry: Body) => entry.action.action === "APPROVE",
    );
    expect(approval.actor.id).toBe(ids.faculty);
    expect(approval.requestTitle).toBe("Organize workshop");
    expect(trail.json.data.history.some((entry: Body) => entry.action.action === "SUBMIT")).toBe(
      true,
    );

    const replay = await req(
      "POST",
      `/api/v1/approval-requests/${ids.organizeRequest}/decision`,
      { action: "APPROVE", expectedVersion: 2 },
      tokens.faculty,
    );
    expect(replay.status).toBe(409);
  });

  test("approving a resource request confirms its hold", async () => {
    const r = await req(
      "POST",
      `/api/v1/approval-requests/${ids.resourceRequest}/decision`,
      { action: "APPROVE", expectedVersion: 1 },
      tokens.faculty,
    );
    expect(r.status).toBe(200);
    const { db } = getDb();
    const [hold] = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.requestId, ids.resourceRequest as string));
    expect(hold?.status).toBe("CONFIRMED");
    expect(hold?.confirmedAt).not.toBeNull();
    // All required approvals are now approved → READY.
    expect(r.json.data.event.status).toBe("READY");
  });

  test("optional request rejection does not block publishing", async () => {
    const reject = await req(
      "POST",
      `/api/v1/approval-requests/${ids.optionalRequest}/decision`,
      { action: "REJECT", comment: "Budget not available this month.", expectedVersion: 1 },
      tokens.faculty,
    );
    expect(reject.status).toBe(200);

    const publish = await req(
      "POST",
      `/api/v1/events/${ids.event}/publish`,
      { expectedRevision: 1 },
      tokens.lead,
    );
    expect(publish.status).toBe(200);
    expect(publish.json.data.event.status).toBe("PUBLISHED");
    expect(publish.json.data.event.publishedAt).not.toBeNull();
  });

  test("rejection requires an explanatory comment", async () => {
    const detail = await req(
      "GET",
      `/api/v1/approval-requests/${ids.resourceRequest}`,
      undefined,
      tokens.faculty,
    );
    expect(detail.status).toBe(200);
    const noComment = await req(
      "POST",
      `/api/v1/approval-requests/${ids.optionalRequest}/decision`,
      { action: "REQUEST_CHANGES", expectedVersion: 2 },
      tokens.faculty,
    );
    expect(noComment.status).toBe(400);
  });
});

describe("oversight reviews events without changing them", () => {
  test("Admin and HOD can read an event but cannot edit, submit, publish or cancel it", async () => {
    const detail = await req("GET", `/api/v1/events/${ids.event}`, undefined, tokens.admin);
    expect(detail.status).toBe(200);
    const seniorDetail = await req("GET", `/api/v1/events/${ids.event}`, undefined, tokens.senior);
    expect(seniorDetail.status).toBe(200);

    const patch = await req(
      "PATCH",
      `/api/v1/events/${ids.event}`,
      { expectedRevision: 1, capacity: 55 },
      tokens.admin,
    );
    expect(patch.status).toBe(403);

    const submit = await req(
      "POST",
      `/api/v1/events/${ids.event}/submit`,
      { expectedRevision: 1, requests: [] },
      tokens.admin,
    );
    expect(submit.status).toBe(403);

    const publish = await req(
      "POST",
      `/api/v1/events/${ids.event}/publish`,
      { expectedRevision: 1 },
      tokens.admin,
    );
    expect(publish.status).toBe(403);
    const seniorPublish = await req(
      "POST",
      `/api/v1/events/${ids.event}/publish`,
      { expectedRevision: 1 },
      tokens.senior,
    );
    expect(seniorPublish.status).toBe(403);

    const cancel = await req(
      "POST",
      `/api/v1/events/${ids.event}/cancel`,
      { reason: "Oversight cannot cancel" },
      tokens.admin,
    );
    expect(cancel.status).toBe(403);

    const addRequest = await req(
      "POST",
      `/api/v1/events/${ids.event}/approval-requests`,
      {
        type: "ORGANIZE",
        title: "Oversight added this",
        assignedApproverId: ids.faculty,
      },
      tokens.admin,
    );
    expect(addRequest.status).toBe(403);

    const withdraw = await req(
      "POST",
      `/api/v1/approval-requests/${ids.resourceRequest}/cancel`,
      { reason: "Oversight cannot withdraw", expectedVersion: 2 },
      tokens.admin,
    );
    expect(withdraw.status).toBe(403);

    // Reading the invitation list is part of review, even though adding or
    // revoking one is not.
    const invitations = await req(
      "GET",
      `/api/v1/events/${ids.event}/invitations`,
      undefined,
      tokens.senior,
    );
    expect(invitations.status).toBe(200);
  });

  test("a resource cannot be approved while the event still has required changes", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 31),
      tokens.lead,
    );
    expect(created.status).toBe(201);
    const eventId = created.json.data.id as string;
    const w = window(31, 9, 12);
    const submit = await req(
      "POST",
      `/api/v1/events/${eventId}/submit`,
      {
        expectedRevision: 1,
        requests: [
          {
            type: "ORGANIZE",
            title: "Organize guarded event",
            assignedApproverId: ids.faculty,
            isRequired: true,
          },
          {
            type: "RESOURCE_USE",
            title: "Use Room 2",
            assignedApproverId: ids.faculty,
            isRequired: true,
            resources: [{ resourceUnitId: ids.unit2, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    expect(submit.status).toBe(200);
    const organize = submit.json.data.requests.find((r: Body) => r.type === "ORGANIZE").id;
    const resource = submit.json.data.requests.find((r: Body) => r.type === "RESOURCE_USE").id;

    const changes = await req(
      "POST",
      `/api/v1/approval-requests/${organize}/decision`,
      {
        action: "REQUEST_CHANGES",
        comment: "Move the start time and resubmit.",
        expectedVersion: 1,
      },
      tokens.faculty,
    );
    expect(changes.status).toBe(200);
    // The other required request is still pending, so the event has not fallen
    // back to draft yet. The open change still freezes its resource.
    expect(changes.json.data.event.status).toBe("PENDING_APPROVALS");

    const approveResource = await req(
      "POST",
      `/api/v1/approval-requests/${resource}/decision`,
      { action: "APPROVE", expectedVersion: 1 },
      tokens.faculty,
    );
    expect(approveResource.status).toBe(409);
    expect(approveResource.json.error.code).toBe("CONFLICT");

    const { db } = getDb();
    const [hold] = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.requestId, resource));
    expect(hold?.status).toBe("HELD");
  });
});

describe("phase 3 escalation", () => {
  test("faculty escalates to senior, senior to admin, history is preserved", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      { ...eventBody(ids.club as string, 30), audience: "OUTSIDERS_ALLOWED" },
      tokens.lead,
    );
    const eventId = created.json.data.id;
    ids.escalationEvent = eventId;
    const submit = await req(
      "POST",
      `/api/v1/events/${eventId}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize open seminar", assignedApproverId: ids.faculty },
          { type: "INVITE_OUTSIDERS", title: "Invite outsiders", assignedApproverId: ids.faculty },
        ],
      },
      tokens.lead,
    );
    expect(submit.status).toBe(200);
    const requestId = submit.json.data.requests.find((r: Body) => r.type === "INVITE_OUTSIDERS").id;
    ids.escalationRequest = requestId;

    // Skipping a tier is not allowed.
    const skip = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/escalate`,
      { toTier: "ADMIN", comment: "Skip senior please", expectedVersion: 1 },
      tokens.faculty,
    );
    expect(skip.status).toBe(409);

    const toSenior = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/escalate`,
      {
        toTier: "SENIOR",
        assigneeId: ids.senior,
        comment: "External participants need senior approval.",
        expectedVersion: 1,
      },
      tokens.faculty,
    );
    expect(toSenior.status).toBe(200);
    expect(toSenior.json.data.request.currentTier).toBe("SENIOR");
    expect(toSenior.json.data.request.version).toBe(2);

    // The original faculty assignee no longer has authority.
    const staleActor = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/decision`,
      { action: "APPROVE", expectedVersion: 2 },
      tokens.faculty,
    );
    expect(staleActor.status).toBe(403);

    // A senior from another department cannot decide it either.
    const wrongDept = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/decision`,
      { action: "APPROVE", expectedVersion: 2 },
      tokens.otherSenior,
    );
    expect(wrongDept.status).toBe(403);

    const toAdmin = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/escalate`,
      {
        toTier: "ADMIN",
        assigneeId: ids.admin,
        comment: "Institution-wide exposure.",
        expectedVersion: 2,
      },
      tokens.senior,
    );
    expect(toAdmin.status).toBe(200);
    expect(toAdmin.json.data.request.currentTier).toBe("ADMIN");

    const final = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/decision`,
      { action: "APPROVE", comment: "Approved at institution level.", expectedVersion: 3 },
      tokens.admin,
    );
    expect(final.status).toBe(200);

    const detail = await req(
      "GET",
      `/api/v1/approval-requests/${requestId}`,
      undefined,
      tokens.admin,
    );
    const actions = detail.json.data.actions.map((a: Body) => a.action.action);
    expect(actions).toEqual(["SUBMIT", "ESCALATE", "ESCALATE", "APPROVE"]);
    const tiers = detail.json.data.actions.map((a: Body) => a.action.toTier);
    expect(tiers).toEqual(["FACULTY", "SENIOR", "ADMIN", "ADMIN"]);
  });

  test("admin tier cannot escalate further", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 31),
      tokens.lead,
    );
    const submit = await req(
      "POST",
      `/api/v1/events/${created.json.data.id}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize final tier event", assignedApproverId: ids.faculty },
        ],
      },
      tokens.lead,
    );
    const requestId = submit.json.data.requests[0].id;
    await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/escalate`,
      { toTier: "SENIOR", comment: "Needs senior view.", expectedVersion: 1 },
      tokens.faculty,
    );
    await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/escalate`,
      { toTier: "ADMIN", comment: "Needs final approval.", expectedVersion: 2 },
      tokens.senior,
    );
    const beyond = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/escalate`,
      { toTier: "ADMIN", comment: "Even higher please.", expectedVersion: 3 },
      tokens.admin,
    );
    expect(beyond.status).toBe(409);
  });

  test("admin reassignment keeps an audit trail and notifies the new assignee", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 32),
      tokens.lead,
    );
    const submit = await req(
      "POST",
      `/api/v1/events/${created.json.data.id}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize reassign event", assignedApproverId: ids.faculty },
        ],
      },
      tokens.lead,
    );
    const requestId = submit.json.data.requests[0].id;
    const notAdmin = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/reassign`,
      { assigneeId: ids.faculty2, reason: "On leave", expectedVersion: 1 },
      tokens.lead,
    );
    expect(notAdmin.status).toBe(403);

    const reassigned = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/reassign`,
      { assigneeId: ids.faculty2, reason: "Original approver is on leave.", expectedVersion: 1 },
      tokens.admin,
    );
    expect(reassigned.status).toBe(200);
    expect(reassigned.json.data.assignedApproverId).toBe(ids.faculty2);

    const decided = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/decision`,
      { action: "APPROVE", expectedVersion: 2 },
      tokens.faculty2,
    );
    expect(decided.status).toBe(200);
  });

  test("inbox is scoped to the approver's own authority", async () => {
    const facultyInbox = await req("GET", "/api/v1/approvals/inbox", undefined, tokens.faculty);
    expect(facultyInbox.status).toBe(200);
    for (const item of facultyInbox.json.data.items) {
      expect(item.request.assignedApproverId).toBe(ids.faculty);
      expect(item.request.currentTier).toBe("FACULTY");
    }
    const otherInbox = await req("GET", "/api/v1/approvals/inbox", undefined, tokens.otherFaculty);
    const otherIds = otherInbox.json.data.items.map((i: Body) => i.request.id);
    expect(otherIds).not.toContain(ids.escalationRequest);
  });
});

describe("phase 3 revisions and cancellation", () => {
  test("critical change after publish creates a new draft revision and keeps history", async () => {
    const revise = await req(
      "POST",
      `/api/v1/events/${ids.event}/revisions`,
      { expectedRevision: 1, note: "Move to a bigger hall" },
      tokens.lead,
    );
    expect(revise.status).toBe(201);
    expect(revise.json.data.status).toBe("DRAFT");
    expect(revise.json.data.currentRevision).toBe(2);

    // The prior bundle is retired, so the new draft must collect fresh approvals.
    const cleared = await req(
      "GET",
      `/api/v1/events/${ids.event}/approval-bundle`,
      undefined,
      tokens.lead,
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.data.bundle).toBeNull();
    const { db } = getDb();
    const retired = await db
      .select()
      .from(approvalBundles)
      .where(eq(approvalBundles.eventId, ids.event as string));
    expect(retired.some((b) => b.supersededAt !== null)).toBe(true);

    const revisions = await req(
      "GET",
      `/api/v1/events/${ids.event}/revisions`,
      undefined,
      tokens.lead,
    );
    expect(revisions.json.data.items.map((r: Body) => r.revision.revision)).toEqual([2, 1]);

    // Old approvals must not silently authorise the new revision.
    const publish = await req(
      "POST",
      `/api/v1/events/${ids.event}/publish`,
      { expectedRevision: 2 },
      tokens.lead,
    );
    expect(publish.status).toBe(422);
  });

  test("re-submitting supersedes the old bundle and releases its holds", async () => {
    const w = window(20, 9, 12);
    const resubmit = await req(
      "POST",
      `/api/v1/events/${ids.event}/submit`,
      {
        expectedRevision: 2,
        requests: [
          { type: "ORGANIZE", title: "Organize revised workshop", assignedApproverId: ids.faculty },
          {
            type: "RESOURCE_USE",
            title: "Use Lab Room 2 instead",
            assignedApproverId: ids.faculty,
            resources: [{ resourceUnitId: ids.unit2, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    expect(resubmit.status).toBe(200);
    const { db } = getDb();
    const oldHolds = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.requestId, ids.resourceRequest as string));
    expect(oldHolds.every((h) => h.status === "RELEASED")).toBe(true);
    const superseded = await db
      .select()
      .from(approvalBundles)
      .where(eq(approvalBundles.id, ids.bundle as string));
    expect(superseded[0]?.supersededAt).not.toBeNull();
  });

  test("cancel releases holds and closes pending requests", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 40),
      tokens.lead,
    );
    const eventId = created.json.data.id;
    const w = window(40, 9, 12);
    const submit = await req(
      "POST",
      `/api/v1/events/${eventId}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize cancel test", assignedApproverId: ids.faculty },
          {
            type: "RESOURCE_USE",
            title: "Lab for cancel test",
            assignedApproverId: ids.faculty,
            resources: [{ resourceUnitId: ids.unit1, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    const requestId = submit.json.data.requests[0].id;
    const cancel = await req(
      "POST",
      `/api/v1/events/${eventId}/cancel`,
      { reason: "Speaker unavailable." },
      tokens.lead,
    );
    expect(cancel.status).toBe(200);
    expect(cancel.json.data.status).toBe("CANCELLED");
    expect(cancel.json.data.cancellationReason).toBe("Speaker unavailable.");

    const { db } = getDb();
    const holds = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.eventId, eventId));
    expect(holds.every((h) => h.status === "RELEASED")).toBe(true);
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(request?.status).toBe("CANCELLED");
  });

  test("withdrawing a resource request releases only its own holds", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 41),
      tokens.lead,
    );
    const eventId = created.json.data.id;
    const w = window(41, 9, 12);
    const submit = await req(
      "POST",
      `/api/v1/events/${eventId}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize withdraw test", assignedApproverId: ids.faculty },
          {
            type: "RESOURCE_USE",
            title: "Lab for withdraw test",
            assignedApproverId: ids.faculty,
            resources: [{ resourceUnitId: ids.unit1, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    const resourceRequestId = submit.json.data.requests.find(
      (r: Body) => r.type === "RESOURCE_USE",
    ).id;
    const withdraw = await req(
      "POST",
      `/api/v1/approval-requests/${resourceRequestId}/cancel`,
      { reason: "Venue no longer needed.", expectedVersion: 1 },
      tokens.lead,
    );
    expect(withdraw.status).toBe(200);
    const { db } = getDb();
    const holds = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.requestId, resourceRequestId));
    expect(holds[0]?.status).toBe("RELEASED");
  });
});

describe("phase 3 resources", () => {
  test("inventory management is admin/HOD-scoped, coordinators read only", async () => {
    const asCoordinator = await req(
      "POST",
      "/api/v1/resources",
      { kind: "EQUIPMENT", name: "Rogue projector", code: `P3-ROGUE-${stamp}`, unitLabels: ["P1"] },
      tokens.lead,
    );
    expect(asCoordinator.status).toBe(403);

    const wrongDept = await req(
      "POST",
      "/api/v1/resources",
      {
        kind: "EQUIPMENT",
        name: "Other dept projector",
        code: `P3-OTHER-${stamp}`,
        departmentId: ids.deptB,
        unitLabels: ["P1"],
      },
      tokens.senior,
    );
    expect(wrongDept.status).toBe(403);

    const asSenior = await req(
      "POST",
      "/api/v1/resources",
      {
        name: "Dept projector",
        departmentId: ids.dept,
        unitLabels: ["Projector 01", "Projector 02"],
      },
      tokens.senior,
    );
    expect(asSenior.status).toBe(201);
    expect(asSenior.json.data.units).toHaveLength(2);
    ids.projectorUnit = asSenior.json.data.units[0].id;
    ids.projectorResource = asSenior.json.data.id;
  });

  test("availability reports busy blocks without leaking other events", async () => {
    const w = window(20, 9, 12);
    const r = await req(
      "GET",
      `/api/v1/resources/availability?startsAt=${encodeURIComponent(w.startsAt)}&endsAt=${encodeURIComponent(w.endsAt)}&resourceId=${ids.resource}`,
      undefined,
      tokens.lead,
    );
    expect(r.status).toBe(200);
    const unit1 = r.json.data.items.find((i: Body) => i.resourceUnitId === ids.unit1);
    expect(unit1).toBeTruthy();
    expect(typeof unit1.available).toBe("boolean");
    expect(Array.isArray(unit1.busyBlocks)).toBe(true);
    expect(JSON.stringify(r.json.data)).not.toContain("createdBy");
  });

  test("a unit with upcoming bookings cannot be retired silently", async () => {
    const { db } = getDb();
    const [unit] = await db
      .select()
      .from(resourceUnits)
      .where(eq(resourceUnits.id, ids.unit2 as string));
    expect(unit).toBeTruthy();
    const r = await req(
      "PATCH",
      `/api/v1/resource-units/${ids.unit2}`,
      { status: "MAINTENANCE" },
      tokens.admin,
    );
    expect(r.status).toBe(409);
  });

  test("maintenance units cannot be requested", async () => {
    const created = await req(
      "POST",
      "/api/v1/resources",
      {
        kind: "EQUIPMENT",
        name: "Spare mic",
        code: `P3-MIC-${stamp}`,
        departmentId: ids.dept,
        unitLabels: ["Mic 01"],
      },
      tokens.admin,
    );
    const unitId = created.json.data.units[0].id;
    await req("PATCH", `/api/v1/resource-units/${unitId}`, { status: "MAINTENANCE" }, tokens.admin);
    const ev = await req("POST", "/api/v1/events", eventBody(ids.club as string, 42), tokens.lead);
    const w = window(42, 9, 12);
    const submit = await req(
      "POST",
      `/api/v1/events/${ev.json.data.id}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize mic test", assignedApproverId: ids.faculty },
          {
            type: "RESOURCE_USE",
            title: "Use spare mic",
            assignedApproverId: ids.faculty,
            resources: [{ resourceUnitId: unitId, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    expect(submit.status).toBe(409);
    expect(submit.json.error.code).toBe("RESOURCE_CONFLICT");
  });

  test("calendar window is bounded", async () => {
    const w = window(20, 0, 23);
    const far = window(200, 0, 23);
    const tooWide = await req(
      "GET",
      `/api/v1/resources/calendar?startsAt=${encodeURIComponent(w.startsAt)}&endsAt=${encodeURIComponent(far.endsAt)}`,
      undefined,
      tokens.lead,
    );
    expect(tooWide.status).toBe(400);
    const okRange = await req(
      "GET",
      `/api/v1/resources/calendar?startsAt=${encodeURIComponent(w.startsAt)}&endsAt=${encodeURIComponent(window(25, 0, 23).endsAt)}`,
      undefined,
      tokens.lead,
    );
    expect(okRange.status).toBe(200);
  });
});

describe("phase 3 invitations and eligibility", () => {
  test("invitations are idempotent per email and revocable", async () => {
    const email = `p3.invitee.${stamp}@test.campusops.local`;
    const first = await req(
      "POST",
      `/api/v1/events/${ids.escalationEvent}/invitations`,
      { emails: [email, email.toUpperCase()] },
      tokens.lead,
    );
    expect(first.status).toBe(201);
    expect(first.json.data.invited).toBe(1);
    const again = await req(
      "POST",
      `/api/v1/events/${ids.escalationEvent}/invitations`,
      { emails: [email] },
      tokens.lead,
    );
    expect(again.json.data.invited).toBe(1);
    const list = await req(
      "GET",
      `/api/v1/events/${ids.escalationEvent}/invitations`,
      undefined,
      tokens.lead,
    );
    expect(list.json.data.items).toHaveLength(1);
    const inviteId = list.json.data.items[0].id;
    const revoke = await req(
      "DELETE",
      `/api/v1/events/${ids.escalationEvent}/invitations/${inviteId}`,
      undefined,
      tokens.lead,
    );
    expect(revoke.status).toBe(200);
    expect(revoke.json.data.revokedAt).not.toBeNull();
  });

  test("eligibility preview explains restrictions", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      {
        ...eventBody(ids.club as string, 45),
        eligibilityPolicy: {
          version: 1,
          accountTypes: ["OUTSIDER_STUDENT"],
          departmentIds: [],
          graduationYears: [],
          requireInvitation: false,
        },
      },
      tokens.lead,
    );
    const preview = await req(
      "GET",
      `/api/v1/events/${created.json.data.id}/eligibility-preview`,
      undefined,
      tokens.lead,
    );
    expect(preview.status).toBe(200);
    expect(preview.json.data.eligible).toBe(false);
    expect(preview.json.data.reasons).toContain("ACCOUNT_TYPE_NOT_ALLOWED");
    expect(preview.json.data.canApply).toBe(false);
  });
});

describe("phase 3 concurrency", () => {
  test("20 parallel submissions for one unit produce exactly one active hold", async () => {
    const { db } = getDb();
    const [resource] = await db
      .insert(resources)
      .values({
        kind: "EQUIPMENT",
        name: `P3 Race Projector ${stamp}`,
        code: `P3-RACE-${stamp}`,
        departmentId: ids.dept,
      })
      .returning();
    const [unit] = await db
      .insert(resourceUnits)
      .values({
        resourceId: resource?.id as string,
        label: "Race unit",
        code: `P3-RACE-U-${stamp}`,
      })
      .returning();
    const unitId = unit?.id as string;
    const w = window(50, 9, 12);

    const eventIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const created = await req(
        "POST",
        "/api/v1/events",
        { ...eventBody(ids.club as string, 50), ...w, registrationClosesAt: w.startsAt },
        tokens.lead,
      );
      eventIds.push(created.json.data.id);
    }
    const results = await Promise.all(
      eventIds.map((eventId) =>
        req(
          "POST",
          `/api/v1/events/${eventId}/submit`,
          {
            expectedRevision: 1,
            requests: [
              { type: "ORGANIZE", title: "Organize race event", assignedApproverId: ids.faculty },
              {
                type: "RESOURCE_USE",
                title: "Race for the projector",
                assignedApproverId: ids.faculty,
                resources: [{ resourceUnitId: unitId, ...w }],
              },
            ],
          },
          tokens.lead,
        ),
      ),
    );
    const successes = results.filter((r) => r.status === 200);
    const conflicts = results.filter(
      (r) => r.status === 409 && r.json.error?.code === "RESOURCE_CONFLICT",
    );
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(19);

    const holds = await db
      .select()
      .from(resourceReservations)
      .where(
        and(
          eq(resourceReservations.resourceUnitId, unitId),
          inArray(resourceReservations.status, ["HELD", "CONFIRMED"]),
        ),
      );
    expect(holds).toHaveLength(1);
  });

  test("parallel decisions on one request produce exactly one effective decision", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 51),
      tokens.lead,
    );
    const submit = await req(
      "POST",
      `/api/v1/events/${created.json.data.id}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize decision race", assignedApproverId: ids.faculty },
        ],
      },
      tokens.lead,
    );
    const requestId = submit.json.data.requests[0].id;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        req(
          "POST",
          `/api/v1/approval-requests/${requestId}/decision`,
          { action: "APPROVE", expectedVersion: 1 },
          tokens.faculty,
        ),
      ),
    );
    expect(attempts.filter((a) => a.status === 200)).toHaveLength(1);
    const { db } = getDb();
    const actions = await db
      .select()
      .from(approvalActions)
      .where(and(eq(approvalActions.requestId, requestId), eq(approvalActions.action, "APPROVE")));
    expect(actions).toHaveLength(1);
  });
});

describe("phase 3 jobs", () => {
  test("expired holds are released and the request is sent back for changes", async () => {
    const { db } = getDb();
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 52),
      tokens.lead,
    );
    const eventId = created.json.data.id;
    const w = window(52, 9, 12);
    const submit = await req(
      "POST",
      `/api/v1/events/${eventId}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize expiry test", assignedApproverId: ids.faculty },
          {
            type: "RESOURCE_USE",
            title: "Lab for expiry test",
            assignedApproverId: ids.faculty,
            resources: [{ resourceUnitId: ids.unit1, ...w }],
          },
        ],
      },
      tokens.lead,
    );
    const requestId = submit.json.data.requests.find((r: Body) => r.type === "RESOURCE_USE").id;
    await db
      .update(resourceReservations)
      .set({ holdExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(resourceReservations.requestId, requestId));

    const { expireResourceHolds } = await import("../src/jobs/maintenance");
    const result = await expireResourceHolds();
    expect(result.expired).toBeGreaterThan(0);

    const [hold] = await db
      .select()
      .from(resourceReservations)
      .where(eq(resourceReservations.requestId, requestId));
    expect(hold?.status).toBe("EXPIRED");
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(request?.status).toBe("CHANGES_REQUESTED");

    // The coordinator can re-request the same unit once the hold expired.
    const attach = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/resources`,
      { expectedVersion: request?.version, resources: [{ resourceUnitId: ids.unit1, ...w }] },
      tokens.lead,
    );
    expect(attach.status).toBe(200);
    const revived = await db
      .select()
      .from(resourceReservations)
      .where(
        and(eq(resourceReservations.requestId, requestId), eq(resourceReservations.status, "HELD")),
      );
    expect(revived).toHaveLength(1);
  });

  test("outbox rows are queued in the business transaction and dispatched after commit", async () => {
    const { db } = getDb();
    const { notificationOutbox } = await import("../src/db/schema");
    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.eventId, ids.escalationEvent as string));
    expect(rows.length).toBeGreaterThan(0);
    const { dispatchOutbox } = await import("../src/modules/notifications/outbox");
    const result = await dispatchOutbox(50);
    expect(result.processed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });

  test("maintenance endpoint is admin-only", async () => {
    const forbidden = await req("POST", "/api/v1/admin/jobs/maintenance", {}, tokens.lead);
    expect(forbidden.status).toBe(403);
    const allowed = await req("POST", "/api/v1/admin/jobs/maintenance", {}, tokens.admin);
    expect(allowed.status).toBe(200);
  });
});

describe("phase 3 audit history and account context", () => {
  test("event audit history is scoped, append-only and redacted", async () => {
    const created = await req(
      "POST",
      "/api/v1/events",
      eventBody(ids.club as string, 60),
      tokens.lead,
    );
    const eventId = created.json.data.id as string;
    const submit = await req(
      "POST",
      `/api/v1/events/${eventId}/submit`,
      {
        expectedRevision: 1,
        requests: [
          { type: "ORGANIZE", title: "Organize audit test", assignedApproverId: ids.faculty },
        ],
      },
      tokens.lead,
    );
    expect(submit.status).toBe(200);
    const requestId = submit.json.data.requests[0].id as string;
    const decided = await req(
      "POST",
      `/api/v1/approval-requests/${requestId}/decision`,
      { action: "APPROVE", expectedVersion: 1 },
      tokens.faculty,
    );
    expect(decided.status).toBe(200);

    const coordinatorView = await req(
      "GET",
      `/api/v1/events/${eventId}/audit`,
      undefined,
      tokens.lead,
    );
    expect(coordinatorView.status).toBe(200);
    const actions = coordinatorView.json.data.items.map((r: Body) => r.action);
    expect(actions).toContain("EVENT_CREATED");
    expect(actions).toContain("EVENT_SUBMITTED");
    expect(coordinatorView.json.data.items[0].actor.fullName).toBeTruthy();

    // Faculty see approval history only, not unrelated club administration.
    const facultyView = await req(
      "GET",
      `/api/v1/events/${eventId}/audit`,
      undefined,
      tokens.faculty2,
    );
    expect(facultyView.status).toBe(200);
    for (const item of facultyView.json.data.items) {
      expect(item.entityType).toBe("approval_request");
    }

    // A coordinator of another club cannot read this event's history at all.
    const outsider = await req(
      "GET",
      `/api/v1/events/${eventId}/audit`,
      undefined,
      tokens.otherLead,
    );
    expect(outsider.status).toBe(404);

    // Filtering and pagination are honoured.
    const filtered = await req(
      "GET",
      `/api/v1/events/${eventId}/audit?action=EVENT_CREATED&limit=1`,
      undefined,
      tokens.lead,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.json.data.items).toHaveLength(1);
    expect(filtered.json.data.items[0].action).toBe("EVENT_CREATED");

    // The table itself refuses mutation.
    const { db } = getDb();
    const { auditLogs } = await import("../src/db/schema");
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.eventId, eventId)).limit(1);
    expect(row).toBeDefined();
    // Drizzle builders are lazy thenables, so force execution inside a real promise.
    await expect(
      (async () => {
        await db.delete(auditLogs).where(eq(auditLogs.id, row?.id as string));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await db
          .update(auditLogs)
          .set({ action: "TAMPERED" })
          .where(eq(auditLogs.id, row?.id as string));
      })(),
    ).rejects.toThrow();
  });

  test("/me exposes the roles and memberships the portal needs", async () => {
    const senior = await req("GET", "/api/v1/me", undefined, tokens.senior);
    expect(senior.status).toBe(200);
    expect(senior.json.data.globalRoles.map((r: Body) => r.role)).toContain("HOD_DEAN");
    expect(senior.json.data.clubMemberships).toEqual([]);

    const lead = await req("GET", "/api/v1/me", undefined, tokens.lead);
    expect(lead.status).toBe(200);
    expect(lead.json.data.globalRoles).toEqual([]);
    expect(lead.json.data.clubMemberships).toHaveLength(1);
    expect(lead.json.data.clubMemberships[0].clubRole).toBe("LEAD");
    expect(lead.json.data.clubMemberships[0].isActive).toBe(true);
    expect(lead.json.data.clubMemberships[0].clubName).toBeTruthy();
    // Password material never leaves the API.
    expect(JSON.stringify(lead.json.data)).not.toContain("passwordHash");
  });

  test("quiz-ranked admission is drafted freely but cannot be submitted without a quiz", async () => {
    let revision = 1;
    for (const admissionMode of ["QUIZ_TOP_N", "QUIZ_FIRST_QUALIFIED"]) {
      const created = await req(
        "POST",
        "/api/v1/events",
        { ...eventBody(ids.club as string, 61), admissionMode },
        tokens.lead,
      );
      // The quiz is attached from the event workspace, so the draft itself is legal.
      expect(created.status).toBe(201);
      expect(created.json.data.admissionMode).toBe(admissionMode);
      revision = created.json.data.currentRevision;

      const patched = await req(
        "PATCH",
        `/api/v1/events/${created.json.data.id}`,
        {
          expectedRevision: revision,
          admissionMode: admissionMode === "QUIZ_TOP_N" ? "QUIZ_FIRST_QUALIFIED" : "QUIZ_TOP_N",
        },
        tokens.lead,
      );
      expect(patched.status).toBe(200);

      // Submitting is the gate: without a matching quiz the event cannot move on.
      const submitted = await req(
        "POST",
        `/api/v1/events/${created.json.data.id}/submit`,
        {
          expectedRevision: revision,
          requests: [
            { type: "ORGANIZE", title: "Organize the quiz round", assignedApproverId: ids.faculty },
          ],
        },
        tokens.lead,
      );
      expect(submitted.status).toBe(422);
      expect(submitted.json.error.code).toBe("QUIZ_REQUIRED");
    }
  });
});
