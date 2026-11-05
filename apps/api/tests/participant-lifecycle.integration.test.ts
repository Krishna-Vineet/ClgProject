import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  announcementReads,
  announcements,
  clubMemberships,
  clubs,
  departments,
  notificationDevices,
  passes,
  registrationHistory,
  registrations,
  roleAssignments,
  scanLogs,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";
import { isExpoPushToken } from "../src/utils/push";

/**
 * Participant lifecycle (withdrawal, waitlist promotion, manual decisions),
 * announcements with their privacy rules, push devices, and offline scan sync.
 */
const app = createApp();
const PASSWORD = "Lifecycle-Test-Password!";
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
const emails: Record<string, string> = {};

async function account(label: string, kind: "staff" | "student", admin = false) {
  const { db } = getDb();
  const email = `life.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: kind === "staff" ? "STAFF" : "COLLEGE_STUDENT",
      status: "ACTIVE",
      fullName: `Life ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!u) throw new Error("insert failed");
  if (kind === "staff") {
    await db
      .insert(staffProfiles)
      .values({ userId: u.id, departmentId: ids.dept as string, designation: "Coordinator" });
    if (admin)
      await db.insert(roleAssignments).values({ userId: u.id, role: "ADMIN", scopeType: "GLOBAL" });
  } else {
    await db.insert(studentProfiles).values({
      userId: u.id,
      studentKind: "COLLEGE_STUDENT",
      rollNumber: `LF${stamp}${rnd()}`.slice(0, 20),
      collegeIdNumber: `LID-${rnd()}`,
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
  emails[label] = email;
}

async function makeEvent(
  label: string,
  mode: "FCFS" | "MANUAL",
  capacity: number,
  audience: "COLLEGE_ONLY" | "OUTSIDERS_ALLOWED" = "COLLEGE_ONLY",
) {
  const { db } = getDb();
  const [event] = await db
    .insert(events)
    .values({
      clubId: ids.club as string,
      title: `Lifecycle ${label} ${stamp}`,
      slug: `life-${label}-${stamp}-${rnd()}`,
      description: "Lifecycle test event.",
      capacity,
      admissionMode: mode,
      audience,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
      registrationOpensAt: new Date(Date.now() - 86_400_000),
      registrationClosesAt: new Date(Date.now() + 86_400_000),
      venueSummary: "Hall",
      status: "PUBLISHED",
      publishedAt: new Date(Date.now() - 3_600_000),
      createdBy: ids.lead as string,
    })
    .returning();
  if (!event) throw new Error("event failed");
  return event.id;
}

async function register(eventId: string, label: string) {
  return req("POST", `/api/v1/events/${eventId}/register`, {}, tokens[label]);
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `LF${stamp}`.slice(0, 20), name: "Lifecycle Dept" })
    .returning();
  if (!dept) throw new Error("dept failed");
  ids.dept = dept.id;
  await account("admin", "staff", true);
  await account("lead", "staff");
  await account("strangerStaff", "staff");
  for (const label of ["a", "b", "c", "d", "outsider"]) await account(label, "student");

  const [club] = await db
    .insert(clubs)
    .values({
      name: `Lifecycle Club ${stamp}`,
      slug: `life-club-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin as string,
    })
    .returning();
  if (!club) throw new Error("club failed");
  ids.club = club.id;
  await db
    .insert(clubMemberships)
    .values({ clubId: club.id, userId: ids.lead as string, clubRole: "LEAD" });
});

describe("withdrawal and waitlist promotion", () => {
  test("a full event waitlists the next participant, then promotes on withdrawal", async () => {
    const eventId = await makeEvent(`promo-${rnd()}`, "FCFS", 1);
    ids.promoEvent = eventId;
    const first = await register(eventId, "a");
    expect(first.status).toBe(201);
    expect(first.json.data.registration.status).toBe("CONFIRMED");
    const second = await register(eventId, "b");
    expect(second.json.data.registration.status).toBe("WAITLISTED");
    expect(second.json.data.registration.queuePosition).toBe(1);

    const withdrawn = await req(
      "POST",
      `/api/v1/events/${eventId}/withdraw`,
      { reason: "Clash with a class" },
      tokens.a,
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.json.data.registration.status).toBe("CANCELLED");
    expect(withdrawn.json.data.promotedRegistrationId).toBe(second.json.data.registration.id);

    const { db } = getDb();
    const [promoted] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, second.json.data.registration.id));
    expect(promoted?.status).toBe("CONFIRMED");
    expect(promoted?.promotedFromWaitlist).toBe(true);
    expect(promoted?.queuePosition).toBeNull();
  });

  test("the withdrawn pass is revoked and the promoted one is usable", async () => {
    const { db } = getDb();
    const rows = await db
      .select({
        status: registrations.status,
        userId: registrations.userId,
        passId: passes.id,
        revokedAt: passes.revokedAt,
      })
      .from(registrations)
      .leftJoin(passes, eq(passes.registrationId, registrations.id))
      .where(eq(registrations.eventId, ids.promoEvent as string));
    const cancelled = rows.find((r) => r.userId === ids.a);
    const confirmed = rows.find((r) => r.userId === ids.b);
    expect(cancelled?.revokedAt).not.toBeNull();
    expect(confirmed?.passId).not.toBeNull();
    expect(confirmed?.revokedAt).toBeNull();
  });

  test("promotion follows queue order, not alphabetical or random order", async () => {
    const eventId = await makeEvent(`queue-${rnd()}`, "FCFS", 1);
    await register(eventId, "c");
    const w1 = await register(eventId, "d");
    const w2 = await register(eventId, "b");
    expect(w1.json.data.registration.queuePosition).toBe(1);
    expect(w2.json.data.registration.queuePosition).toBe(2);
    await req("POST", `/api/v1/events/${eventId}/withdraw`, {}, tokens.c);
    const { db } = getDb();
    const rows = await db.select().from(registrations).where(eq(registrations.eventId, eventId));
    expect(rows.find((r) => r.userId === ids.d)?.status).toBe("CONFIRMED");
    const stillWaiting = rows.find((r) => r.userId === ids.b);
    expect(stillWaiting?.status).toBe("WAITLISTED");
    // The queue closes the gap so positions stay 1..n.
    expect(stillWaiting?.queuePosition).toBe(1);
  });

  test("withdrawing twice is idempotent and promotes nobody extra", async () => {
    const eventId = ids.promoEvent as string;
    const again = await req("POST", `/api/v1/events/${eventId}/withdraw`, {}, tokens.a);
    expect(again.status).toBe(200);
    expect(again.json.data.alreadyCancelled).toBe(true);
    expect(again.json.data.promotedRegistrationId).toBeNull();
  });

  test("a withdrawn place disappears from the student's list but can be claimed again", async () => {
    const { db } = getDb();
    const eventId = await makeEvent(`rejoin-${rnd()}`, "FCFS", 2);
    const first = await register(eventId, "a");
    expect(first.json.data.registration.status).toBe("CONFIRMED");

    await req("POST", `/api/v1/events/${eventId}/withdraw`, {}, tokens.a);

    // Gone from the phone: a cancelled registration is not something you hold.
    const mine = await req("GET", "/api/v1/me/registrations?limit=100", undefined, tokens.a);
    const listed = mine.json.data.items.filter((r: { eventId: string }) => r.eventId === eventId);
    expect(listed).toHaveLength(0);

    // ...and the detail screen offers Register again rather than "closed".
    const view = await req("GET", `/api/v1/events/${eventId}/participant`, undefined, tokens.a);
    expect(view.json.data.registration).toBeNull();

    // Seats remain, so the rules permit it.
    const again = await register(eventId, "a");
    expect(again.status).toBe(201);
    expect(again.json.data.alreadyRegistered).toBe(false);
    expect(again.json.data.registration.status).toBe("CONFIRMED");

    // The same row was reused (one row per student per event), history intact,
    // and the pass that was revoked on withdrawal works again.
    const rows = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, ids.a as string)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.json.data.registration.id);
    expect(rows[0]?.cancelledAt).toBeNull();
    const row = rows[0];
    if (!row) throw new Error("registration row missing");
    const [pass] = await db.select().from(passes).where(eq(passes.registrationId, row.id));
    expect(pass?.revokedAt).toBeNull();
  });

  test("re-registering stops when the seats are gone, without granting a seat out of thin air", async () => {
    const eventId = await makeEvent(`rejoinfull-${rnd()}`, "FCFS", 1);
    await register(eventId, "b");
    const a = await register(eventId, "a");
    expect(a.json.data.registration.status).toBe("WAITLISTED");
    await req("POST", `/api/v1/events/${eventId}/withdraw`, {}, tokens.a);
    const again = await register(eventId, "a");
    expect(again.json.data.registration.status).toBe("WAITLISTED");
    expect(again.json.data.registration.queuePosition).toBe(1);
  });

  test("a non-participant cannot withdraw from an event they never joined", async () => {
    const res = await req("POST", `/api/v1/events/${ids.promoEvent}/withdraw`, {}, tokens.outsider);
    expect(res.status).toBe(404);
  });

  test("the status trail explains the promotion to the participant", async () => {
    const res = await req(
      "GET",
      `/api/v1/events/${ids.promoEvent}/registration-history`,
      undefined,
      tokens.b,
    );
    expect(res.status).toBe(200);
    const statuses = (res.json.data.items as Body[]).map((i) => i.toStatus);
    expect(statuses).toEqual(["WAITLISTED", "CONFIRMED"]);
  });

  test("withdrawal is refused once the event has started", async () => {
    const { db } = getDb();
    const eventId = await makeEvent(`started-${rnd()}`, "FCFS", 5);
    await register(eventId, "outsider");
    await db
      .update(events)
      .set({
        status: "LIVE",
        startsAt: new Date(Date.now() - 3_600_000),
        // The DB enforces registrationClosesAt <= startsAt, so move both.
        registrationClosesAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(events.id, eventId));
    const res = await req("POST", `/api/v1/events/${eventId}/withdraw`, {}, tokens.outsider);
    expect(res.status).toBe(409);
  });

  test("an organiser can release a place and the seat is promoted", async () => {
    const eventId = await makeEvent(`remove-${rnd()}`, "FCFS", 1);
    const held = await register(eventId, "a");
    const waiting = await register(eventId, "c");
    const res = await req(
      "POST",
      `/api/v1/events/${eventId}/registrations/${held.json.data.registration.id}/remove`,
      { reason: "Duplicate registration" },
      tokens.lead,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.promotedRegistrationId).toBe(waiting.json.data.registration.id);
  });

  test("an unrelated staff account cannot remove a participant", async () => {
    const { db } = getDb();
    const [reg] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, ids.promoEvent as string))
      .limit(1);
    const res = await req(
      "POST",
      `/api/v1/events/${ids.promoEvent}/registrations/${reg?.id}/remove`,
      { reason: "Should not be allowed" },
      tokens.strangerStaff,
    );
    expect(res.status).toBe(403);
  });
});

describe("manual application decisions", () => {
  test("a manual event creates an application, not a confirmation", async () => {
    const eventId = await makeEvent(`manual-${rnd()}`, "MANUAL", 1);
    ids.manualEvent = eventId;
    const applied = await register(eventId, "a");
    expect(applied.json.data.registration.status).toBe("APPLIED");
    ids.application = applied.json.data.registration.id;
    const second = await register(eventId, "b");
    ids.application2 = second.json.data.registration.id;
  });

  test("approving issues a pass; approving beyond capacity waitlists instead of overbooking", async () => {
    const first = await req(
      "POST",
      `/api/v1/events/${ids.manualEvent}/registrations/${ids.application}/decision`,
      { decision: "CONFIRMED", note: "Strong application" },
      tokens.lead,
    );
    expect(first.status).toBe(200);
    expect(first.json.data.applied).toBe("CONFIRMED");

    const second = await req(
      "POST",
      `/api/v1/events/${ids.manualEvent}/registrations/${ids.application2}/decision`,
      { decision: "CONFIRMED" },
      tokens.lead,
    );
    expect(second.status).toBe(200);
    expect(second.json.data.requested).toBe("CONFIRMED");
    expect(second.json.data.applied).toBe("WAITLISTED");

    const { db } = getDb();
    const confirmed = await db
      .select()
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, ids.manualEvent as string),
          eq(registrations.status, "CONFIRMED"),
        ),
      );
    expect(confirmed.length).toBe(1);
  });

  test("rejecting records the reason and issues no pass", async () => {
    const eventId = await makeEvent(`reject-${rnd()}`, "MANUAL", 5);
    const applied = await register(eventId, "c");
    const res = await req(
      "POST",
      `/api/v1/events/${eventId}/registrations/${applied.json.data.registration.id}/decision`,
      { decision: "REJECTED", note: "Eligibility not met" },
      tokens.lead,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.registration.status).toBe("REJECTED");
    expect(res.json.data.registration.rejectionReason).toBe("Eligibility not met");
  });

  test("deciding an already-decided registration is refused", async () => {
    const res = await req(
      "POST",
      `/api/v1/events/${ids.manualEvent}/registrations/${ids.application}/decision`,
      { decision: "REJECTED" },
      tokens.lead,
    );
    expect(res.status).toBe(409);
  });

  test("decisions are refused on a non-manual event", async () => {
    const { db } = getDb();
    const [reg] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, ids.promoEvent as string))
      .limit(1);
    const res = await req(
      "POST",
      `/api/v1/events/${ids.promoEvent}/registrations/${reg?.id}/decision`,
      { decision: "CONFIRMED" },
      tokens.lead,
    );
    expect(res.status).toBe(400);
  });

  test("the roster reports exact totals and respects status filters", async () => {
    const all = await req(
      "GET",
      `/api/v1/events/${ids.manualEvent}/registrations`,
      undefined,
      tokens.lead,
    );
    expect(all.status).toBe(200);
    expect(all.json.data.totals.confirmed).toBe(1);
    expect(all.json.data.totals.waitlisted).toBe(1);
    const filtered = await req(
      "GET",
      `/api/v1/events/${ids.manualEvent}/registrations?status=CONFIRMED`,
      undefined,
      tokens.lead,
    );
    expect((filtered.json.data.items as Body[]).length).toBe(1);
  });

  test("a participant cannot read the organiser roster", async () => {
    const res = await req(
      "GET",
      `/api/v1/events/${ids.manualEvent}/registrations`,
      undefined,
      tokens.a,
    );
    expect(res.status).toBe(404);
  });
});

describe("announcements", () => {
  test("a coordinator posts to registered participants and the fan-out is reported", async () => {
    const res = await req(
      "POST",
      `/api/v1/events/${ids.manualEvent}/announcements`,
      {
        title: "Venue changed",
        body: "Please come to Seminar Hall 2.",
        audience: "REGISTERED",
        push: false,
      },
      tokens.lead,
    );
    expect(res.status).toBe(201);
    expect(res.json.data.recipients).toBe(2);
    ids.announcement = res.json.data.announcement.id;
  });

  test("a registered participant sees it; an unrelated student does not", async () => {
    const mine = await req("GET", "/api/v1/me/announcements", undefined, tokens.a);
    expect(mine.status).toBe(200);
    expect((mine.json.data.items as Body[]).some((i) => i.id === ids.announcement)).toBe(true);
    expect(mine.json.data.unread).toBeGreaterThan(0);

    const other = await req("GET", "/api/v1/me/announcements", undefined, tokens.outsider);
    expect((other.json.data.items as Body[]).some((i) => i.id === ids.announcement)).toBe(false);
  });

  test("marking read is idempotent and clears the unread count", async () => {
    const first = await req(
      "POST",
      `/api/v1/me/announcements/${ids.announcement}/read`,
      {},
      tokens.a,
    );
    expect(first.status).toBe(200);
    const again = await req(
      "POST",
      `/api/v1/me/announcements/${ids.announcement}/read`,
      {},
      tokens.a,
    );
    expect(again.status).toBe(200);
    const { db } = getDb();
    const rows = await db
      .select()
      .from(announcementReads)
      .where(eq(announcementReads.announcementId, ids.announcement as string));
    expect(rows.length).toBe(1);
  });

  test("a non-registered student cannot mark a REGISTERED announcement read", async () => {
    const res = await req(
      "POST",
      `/api/v1/me/announcements/${ids.announcement}/read`,
      {},
      tokens.outsider,
    );
    expect(res.status).toBe(404);
  });

  test("ALL_VISIBLE reaches a student who can see the event but has not registered", async () => {
    const eventId = await makeEvent(`visible-${rnd()}`, "FCFS", 50);
    const posted = await req(
      "POST",
      `/api/v1/events/${eventId}/announcements`,
      {
        title: "Open to all",
        body: "Anyone in the college may attend.",
        audience: "ALL_VISIBLE",
        push: false,
      },
      tokens.lead,
    );
    expect(posted.status).toBe(201);
    const inbox = await req("GET", "/api/v1/me/announcements", undefined, tokens.d);
    expect(
      (inbox.json.data.items as Body[]).some((i) => i.id === posted.json.data.announcement.id),
    ).toBe(true);
  });

  test("a recent announcement is still delivered when the database holds many events", async () => {
    // Regression: the inbox used to load the first 200 visible events in memory,
    // so on a busy database new announcements silently disappeared. Visibility
    // is now a SQL predicate, so the count of other events is irrelevant.
    const { db } = getDb();
    const fillerStart = Date.now() - 400 * 86_400_000;
    const filler = Array.from({ length: 210 }, (_, i) => ({
      clubId: ids.club as string,
      title: `Inbox filler ${stamp} ${i}`,
      slug: `inbox-filler-${stamp}-${i}`,
      capacity: 10,
      admissionMode: "FCFS" as const,
      audience: "COLLEGE_ONLY" as const,
      startsAt: new Date(fillerStart),
      endsAt: new Date(fillerStart + 86_400_000),
      registrationOpensAt: new Date(fillerStart - 2 * 86_400_000),
      registrationClosesAt: new Date(fillerStart),
      status: "COMPLETED" as const,
      publishedAt: new Date(fillerStart - 2 * 86_400_000),
      createdBy: ids.lead as string,
    }));
    await db.insert(events).values(filler);
    const mine = await req("GET", "/api/v1/me/announcements", undefined, tokens.a);
    expect(mine.status).toBe(200);
    expect((mine.json.data.items as Body[]).some((i) => i.id === ids.announcement)).toBe(true);
    // And the item carries the event object the phone renders.
    const item = (mine.json.data.items as Body[]).find((i) => i.id === ids.announcement);
    expect(item?.event.title).toContain("Lifecycle");
  });

  test("unrelated staff cannot post; a participant cannot post", async () => {
    const bad = await req(
      "POST",
      `/api/v1/events/${ids.manualEvent}/announcements`,
      { title: "Nope", body: "Should be refused.", push: false },
      tokens.strangerStaff,
    );
    expect(bad.status).toBe(403);
    const student = await req(
      "POST",
      `/api/v1/events/${ids.manualEvent}/announcements`,
      { title: "Nope", body: "Should be refused.", push: false },
      tokens.a,
    );
    expect(student.status).toBe(403);
  });

  test("revoking hides it from the inbox and blocks marking it read", async () => {
    const revoked = await req(
      "POST",
      `/api/v1/announcements/${ids.announcement}/revoke`,
      {},
      tokens.lead,
    );
    expect(revoked.status).toBe(200);
    const inbox = await req("GET", "/api/v1/me/announcements", undefined, tokens.a);
    expect((inbox.json.data.items as Body[]).some((i) => i.id === ids.announcement)).toBe(false);
    const read = await req(
      "POST",
      `/api/v1/me/announcements/${ids.announcement}/read`,
      {},
      tokens.a,
    );
    expect(read.status).toBe(404);
  });

  test("the organiser list shows read counts and includes revoked items", async () => {
    const res = await req(
      "GET",
      `/api/v1/events/${ids.manualEvent}/announcements`,
      undefined,
      tokens.lead,
    );
    expect(res.status).toBe(200);
    const item = (res.json.data.items as Body[]).find((i) => i.id === ids.announcement);
    expect(item?.readCount).toBe(1);
    expect(item?.revokedAt).not.toBeNull();
  });
});

describe("push devices", () => {
  test("token shape is validated the same way the provider expects", () => {
    expect(isExpoPushToken("ExponentPushToken[abc12345678]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc12345678]")).toBe(true);
    expect(isExpoPushToken("not-a-token")).toBe(false);
    expect(isExpoPushToken("ExpoPushToken[short]")).toBe(false);
  });

  test("a device registers, appears in the list, and can be removed", async () => {
    const token = `ExpoPushToken[test-${stamp}-aaaaaaaa]`;
    const added = await req(
      "POST",
      "/api/v1/me/devices",
      { expoPushToken: token, platform: "android" },
      tokens.a,
    );
    expect(added.status).toBe(200);
    const listed = await req("GET", "/api/v1/me/devices", undefined, tokens.a);
    expect((listed.json.data.items as Body[]).length).toBe(1);
    const removed = await req(
      "POST",
      "/api/v1/me/devices/remove",
      { expoPushToken: token },
      tokens.a,
    );
    expect(removed.json.data.removed).toBe(1);
    const { db } = getDb();
    const [row] = await db
      .select()
      .from(notificationDevices)
      .where(eq(notificationDevices.expoPushToken, token));
    expect(row?.isActive).toBe(false);
  });

  test("a shared phone reassigns the token so the previous owner stops being notified", async () => {
    const token = `ExpoPushToken[shared-${stamp}-bbbbbbbb]`;
    await req("POST", "/api/v1/me/devices", { expoPushToken: token, platform: "ios" }, tokens.b);
    await req("POST", "/api/v1/me/devices", { expoPushToken: token, platform: "ios" }, tokens.c);
    const { db } = getDb();
    const rows = await db
      .select()
      .from(notificationDevices)
      .where(eq(notificationDevices.expoPushToken, token));
    expect(rows.length).toBe(1);
    expect(rows[0]?.userId).toBe(ids.c);
  });

  test("one account cannot remove another account's device", async () => {
    const token = `ExpoPushToken[shared-${stamp}-bbbbbbbb]`;
    const res = await req("POST", "/api/v1/me/devices/remove", { expoPushToken: token }, tokens.b);
    expect(res.json.data.removed).toBe(0);
  });
});
