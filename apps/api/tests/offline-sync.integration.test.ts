import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
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
  scanLogs,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/**
 * Offline scan sync. The properties that matter at a gate with no signal:
 * a queued batch can be retried safely, a code grants at most once even if two
 * scanners queued it, and a stale or forged entry is refused.
 */
const app = createApp();
const PASSWORD = "Offline-Test-Password!";
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

async function account(label: string, kind: "staff" | "student") {
  const { db } = getDb();
  const email = `off.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: kind === "staff" ? "STAFF" : "COLLEGE_STUDENT",
      status: "ACTIVE",
      fullName: `Offline ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!u) throw new Error("insert failed");
  if (kind === "staff")
    await db
      .insert(staffProfiles)
      .values({ userId: u.id, departmentId: ids.dept as string, designation: "Coordinator" });
  else
    await db.insert(studentProfiles).values({
      userId: u.id,
      studentKind: "COLLEGE_STUDENT",
      rollNumber: `OF${stamp}${rnd()}`.slice(0, 20),
      collegeIdNumber: `OID-${rnd()}`,
      departmentId: ids.dept as string,
      institutionName: "Test College",
    });
  const login = await req("POST", "/api/v1/auth/login", {
    email,
    password: PASSWORD,
    client: "mobile",
  });
  tokens[label] = login.json.data.accessToken;
  ids[label] = u.id;
}

async function counter(name: string, over: Body = {}) {
  const res = await req(
    "POST",
    `/api/v1/events/${ids.event}/checkpoints`,
    {
      name,
      qrType: "UNLIMITED",
      maxUses: null,
      validityMode: "WINDOW",
      validFrom: new Date(Date.now() - 7_200_000).toISOString(),
      validUntil: new Date(Date.now() + 28_800_000).toISOString(),
      requiresIdCheck: true,
      ...over,
    },
    tokens.lead,
  );
  expect(res.status).toBe(201);
  return res.json.data.id as string;
}

async function mint(student: string, checkpointId: string) {
  const wallet = await req("GET", "/api/v1/me/passes", undefined, tokens[student]);
  const pass = (wallet.json.data.items as Body[]).find((i) => i.event.id === ids.event);
  if (!pass) throw new Error("fixture pass missing");
  const res = await req(
    "POST",
    `/api/v1/me/passes/${pass.passId}/nonce`,
    { checkpointId },
    tokens[student],
  );
  expect(res.status).toBe(200);
  return { token: res.json.data.token as string, passId: pass.passId as string };
}

const item = (token: string, checkpointId: string, over: Body = {}) => ({
  clientScanId: randomUUID(),
  checkpointId,
  token,
  identityCheck: "MATCH",
  capturedAt: new Date(Date.now() - 60_000).toISOString(),
  ...over,
});

async function sync(items: Body[], scanner = "lead") {
  return req("POST", "/api/v1/access/scans/sync", { items }, tokens[scanner]);
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `OF${stamp}`.slice(0, 20), name: "Offline Dept" })
    .returning();
  if (!dept) throw new Error("dept failed");
  ids.dept = dept.id;
  await account("lead", "staff");
  await account("otherScanner", "staff");
  await account("stranger", "staff");
  await account("student", "student");
  await account("student2", "student");

  const [club] = await db
    .insert(clubs)
    .values({
      name: `Offline Club ${stamp}`,
      slug: `off-club-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.lead as string,
    })
    .returning();
  if (!club) throw new Error("club failed");
  ids.club = club.id;
  await db.insert(clubMemberships).values([
    { clubId: club.id, userId: ids.lead as string, clubRole: "LEAD" },
    { clubId: club.id, userId: ids.otherScanner as string, clubRole: "COORDINATOR" },
  ]);

  const [event] = await db
    .insert(events)
    .values({
      clubId: club.id,
      title: `Offline Fest ${stamp}`,
      slug: `off-fest-${stamp}`,
      capacity: 50,
      admissionMode: "FCFS",
      audience: "COLLEGE_ONLY",
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 28_800_000),
      registrationOpensAt: new Date(Date.now() - 86_400_000),
      registrationClosesAt: new Date(Date.now() - 3_600_000),
      status: "LIVE",
      publishedAt: new Date(Date.now() - 86_400_000),
      createdBy: ids.lead as string,
    })
    .returning();
  if (!event) throw new Error("event failed");
  ids.event = event.id;

  for (const label of ["student", "student2"]) {
    const [reg] = await db
      .insert(registrations)
      .values({
        eventId: event.id,
        userId: ids[label] as string,
        status: "CONFIRMED",
        admissionModeSnapshot: "FCFS",
        eligibilitySnapshot: { version: 1 },
        eventRevision: 1,
        confirmedAt: new Date(),
      })
      .returning();
    if (!reg) throw new Error("reg failed");
    await db.insert(passes).values({ registrationId: reg.id });
  }

  ids.gate = await counter("Offline Gate", { qrType: "ONE_TIME", maxUses: null });
  ids.meal = await counter("Offline Meal", { qrType: "COUNTED", maxUses: 2 });
});

describe("offline sync basics", () => {
  test("a queued scan is accepted and attributed to its capture time", async () => {
    const { token } = await mint("student", ids.gate as string);
    const scan = item(token, ids.gate as string);
    const res = await sync([scan]);
    expect(res.status).toBe(200);
    expect(res.json.data.accepted).toBe(1);
    expect(res.json.data.results[0].result).toBe("GRANTED");

    const { db } = getDb();
    const [log] = await db
      .select()
      .from(scanLogs)
      .where(eq(scanLogs.clientScanId, scan.clientScanId));
    expect(log?.syncedOffline).toBe(true);
    expect(log?.capturedAt?.toISOString()).toBe(scan.capturedAt);
    expect(log?.result).toBe("GRANTED");
  });

  test("replaying the same batch is idempotent and consumes nothing", async () => {
    const { db } = getDb();
    const { token } = await mint("student2", ids.meal as string);
    const scan = item(token, ids.meal as string);
    const first = await sync([scan]);
    expect(first.json.data.accepted).toBe(1);
    const before = await db
      .select()
      .from(redemptions)
      .where(eq(redemptions.clientScanId, scan.clientScanId));
    expect(before.length).toBe(1);

    const replay = await sync([scan]);
    expect(replay.status).toBe(200);
    expect(replay.json.data.results[0].duplicate).toBe(true);
    const after = await db
      .select()
      .from(redemptions)
      .where(eq(redemptions.clientScanId, scan.clientScanId));
    expect(after.length).toBe(1);
    const logs = await db
      .select()
      .from(scanLogs)
      .where(eq(scanLogs.clientScanId, scan.clientScanId));
    expect(logs.length).toBe(1);
  });

  test("a batch counting toward a limited QR respects the limit across items", async () => {
    const cp = await counter(`Limited ${rnd()}`, { qrType: "COUNTED", maxUses: 1 });
    const a = await mint("student", cp);
    const b = await mint("student", cp);
    const res = await sync([item(a.token, cp), item(b.token, cp)]);
    expect(res.status).toBe(200);
    expect(res.json.data.accepted).toBe(1);
    expect(res.json.data.refused).toBe(1);
    const reasons = (res.json.data.results as Body[]).map((r) => r.reason);
    expect(reasons).toContain("LIMIT_REACHED");
  });

  test("the same id twice inside one batch is processed once", async () => {
    const { token } = await mint("student", ids.meal as string);
    const scan = item(token, ids.meal as string);
    const res = await sync([scan, { ...scan }]);
    expect(res.json.data.results.length).toBe(2);
    expect(
      (res.json.data.results as Body[]).filter((r) => r.reason === "DUPLICATE_IN_BATCH").length,
    ).toBe(1);
  });
});

describe("offline sync safety", () => {
  test("the same code queued by two scanners grants once and replays for the other", async () => {
    const cp = await counter(`Shared ${rnd()}`, { qrType: "ONE_TIME", maxUses: null });
    const { token } = await mint("student", cp);
    const first = await sync([item(token, cp)], "lead");
    const second = await sync([item(token, cp)], "otherScanner");
    expect(first.json.data.accepted).toBe(1);
    expect(second.json.data.accepted).toBe(0);
    expect(second.json.data.results[0].reason).toBe("QR_REPLAYED");
  });

  test("a scan older than the configured window is refused", async () => {
    const { token } = await mint("student", ids.meal as string);
    const stale = item(token, ids.meal as string, {
      capturedAt: new Date(
        Date.now() - (env.OFFLINE_SCAN_MAX_AGE_MINUTES + 10) * 60_000,
      ).toISOString(),
    });
    const res = await sync([stale]);
    expect(res.json.data.accepted).toBe(0);
    expect(res.json.data.results[0].reason).toBe("SCAN_TOO_OLD");
  });

  test("a capture time far in the future is refused", async () => {
    const { token } = await mint("student", ids.meal as string);
    const res = await sync([
      item(token, ids.meal as string, {
        capturedAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ]);
    expect(res.json.data.results[0].reason).toBe("SCAN_TOO_OLD");
  });

  test("a forged token is refused without consuming anything", async () => {
    const res = await sync([item("not-a-real-token-at-all.padding", ids.meal as string)]);
    expect(res.json.data.accepted).toBe(0);
    expect(["QR_INVALID", "QR_EXPIRED"]).toContain(res.json.data.results[0].reason);
  });

  test("a code minted for another counter is refused as the wrong checkpoint", async () => {
    const { token } = await mint("student", ids.gate as string);
    const res = await sync([item(token, ids.meal as string)]);
    expect(res.json.data.results[0].reason).toBe("WRONG_CHECKPOINT");
  });

  test("an identity mismatch is refused for a QR that requires the check", async () => {
    const cp = await counter(`ID check ${rnd()}`);
    const { token } = await mint("student", cp);
    const res = await sync([item(token, cp, { identityCheck: "MISMATCH" })]);
    expect(res.json.data.results[0].reason).toBe("IDENTITY_MISMATCH");
  });

  test("a scanner outside the event's club cannot sync into it", async () => {
    const { token } = await mint("student", ids.meal as string);
    const res = await sync([item(token, ids.meal as string)], "stranger");
    expect(res.status).toBe(200);
    expect(res.json.data.accepted).toBe(0);
    expect(res.json.data.results[0].reason).toBe("FORBIDDEN");
  });

  test("one bad item does not reject the rest of the batch", async () => {
    const cp = await counter(`Mixed ${rnd()}`);
    const good = await mint("student", cp);
    const res = await sync([item("forged.token", cp), item(good.token, cp)]);
    expect(res.status).toBe(200);
    expect(res.json.data.accepted).toBe(1);
    expect(res.json.data.refused).toBe(1);
  });

  test("an oversized batch is refused", async () => {
    const items = Array.from({ length: env.OFFLINE_SCAN_BATCH_MAX + 1 }, () =>
      item("x.repeat", ids.meal as string),
    );
    const res = await sync(items);
    expect(res.status).toBe(400);
  });

  test("an empty batch is a validation error, not a silent success", async () => {
    const res = await sync([]);
    expect(res.status).toBe(400);
  });

  test("a revoked pass is refused even when the scan was queued earlier", async () => {
    const cp = await counter(`Revoked ${rnd()}`);
    const { token, passId } = await mint("student2", cp);
    // Revoked BEFORE the capture instant, so it was already invalid on the day.
    const { db } = getDb();
    await db
      .update(passes)
      .set({ revokedAt: new Date(Date.now() - 120_000) })
      .where(eq(passes.id, passId));
    const res = await sync([item(token, cp)]);
    expect(res.json.data.results[0].reason).toBe("PASS_REVOKED");
  });
});
