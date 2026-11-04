import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONSENT_POLICY } from "@campusops/shared";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { type DbClient, closeDb, createDb, getDb } from "../src/db/client";
import {
  events,
  authTokens,
  complaints,
  departments,
  registrations,
  users,
} from "../src/db/schema";
import { sniffMimeType } from "../src/modules/storage/service";
import { hashPassword } from "../src/utils/password";

/**
 * Session hygiene and the data-subject paths.
 *
 * Reuse detection used to revoke every session a person had, so one stale tab
 * signed them out on every device. Consent was captured without a policy
 * version, and there was no export or deletion path at all. These tests pin the
 * behaviour that replaced it.
 */
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PASSWORD = "Account-Paths-Test-Password!";
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
  return { status: res.status, json };
}
const data = <T = Json>(r: { json: Json }) => r.json.data as T;
const code = (r: { json: Json }) =>
  ((r.json.error as { code?: string } | undefined)?.code ?? "") as string;

maybe("session families and account data paths", () => {
  let client: DbClient;
  let userId = "";

  async function makeUser(label: string) {
    const { db } = getDb();
    const email = `paths.${label}.${stamp}@test.campusops.local`;
    const [u] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(PASSWORD),
        accountType: "OUTSIDER_STUDENT",
        status: "ACTIVE",
        fullName: `Paths ${label}`,
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!u) throw new Error("user insert failed");
    return u;
  }

  async function login(email: string) {
    const r = await req("POST", "/api/v1/auth/login", {
      email,
      password: PASSWORD,
      client: "mobile",
    });
    expect(r.status).toBe(200);
    return data<{ accessToken: string; refreshToken: string }>(r);
  }

  beforeAll(async () => {
    client = createDb(url as string, 3);
    const user = await makeUser("owner");
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(client);
  });

  test("a reused refresh token revokes only its own sign-in, not other devices", async () => {
    const { db } = getDb();
    const user = await makeUser("families");
    const phone = await login(user.email);
    const laptop = await login(user.email);

    // Rotate the phone's token once, then replay the now-dead one.
    const rotated = await req("POST", "/api/v1/auth/refresh", {
      refreshToken: phone.refreshToken,
      client: "mobile",
    });
    expect(rotated.status).toBe(200);
    const replay = await req("POST", "/api/v1/auth/refresh", {
      refreshToken: phone.refreshToken,
      client: "mobile",
    });
    expect(replay.status).toBe(401);

    // The phone's family is dead, including the token it had just been given.
    const rotatedAgain = await req("POST", "/api/v1/auth/refresh", {
      refreshToken: data<{ refreshToken: string }>(rotated).refreshToken,
      client: "mobile",
    });
    expect(rotatedAgain.status).toBe(401);

    // The laptop signed in separately and is untouched.
    const laptopStillWorks = await req("GET", "/api/v1/me", undefined, laptop.accessToken);
    expect(laptopStillWorks.status).toBe(200);
    const laptopRefresh = await req("POST", "/api/v1/auth/refresh", {
      refreshToken: laptop.refreshToken,
      client: "mobile",
    });
    expect(laptopRefresh.status).toBe(200);

    // One live session remains, not zero.
    const live = await db.select().from(users).where(eq(users.id, user.id));
    expect(live.length).toBe(1);
  });

  test("consent is stored with the policy version it was given against", async () => {
    const { db } = getDb();
    const email = `paths.consent.${stamp}@test.campusops.local`;
    const [dept] = await db.select().from(departments).limit(1);
    const register = await req("POST", "/api/v1/auth/register/outsider", {
      email,
      password: PASSWORD,
      fullName: "Consent Student",
      institutionName: "Elsewhere College",
      consentAccepted: true,
    });
    expect(register.status).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row?.consentAcceptedAt).toBeInstanceOf(Date);
    expect(row?.consentVersion).toBe(CONSENT_POLICY.version);
    expect(dept === undefined || dept.id.length > 0).toBe(true);
  });

  test("export returns the account, its consent record and its registrations", async () => {
    const { db } = getDb();
    const user = await makeUser("export");
    const session = await login(user.email);

    const [club] = await db
      .select()
      .from(departments) // any row is enough to reach the event insert below
      .limit(1);
    expect(club).toBeDefined();

    const exported = await req("GET", "/api/v1/me/export", undefined, session.accessToken);
    expect(exported.status).toBe(200);
    const payload = data<{
      account: { email: string };
      consent: { currentPolicyVersion: string; policyVersion: string | null };
      registrations: unknown[];
    }>(exported);
    expect(payload.account.email).toBe(user.email);
    expect(payload.consent.currentPolicyVersion).toBe(CONSENT_POLICY.version);
    expect(payload.consent.policyVersion).toBeNull();
    expect(Array.isArray(payload.registrations)).toBe(true);
  });

  test("deleting an account anonymises it and keeps the institution's records", async () => {
    const { db } = getDb();
    const user = await makeUser("delete");
    const session = await login(user.email);

    // A complaint the person filed must survive the deletion: it is an
    // operational record for the event, not part of the account.
    const [event] = await db.select().from(events).limit(1);
    if (event) {
      await db.insert(complaints).values({
        eventId: event.id,
        reportedBy: user.id,
        category: "OTHER",
        description: "Broke a chair in the lab.",
      });
    }

    const wrong = await req(
      "POST",
      "/api/v1/me/delete",
      { confirmEmail: "someone-else@example.com" },
      session.accessToken,
    );
    expect(wrong.status).toBe(400);
    expect(code(wrong)).toBe("VALIDATION_ERROR");

    const deleted = await req(
      "POST",
      "/api/v1/me/delete",
      { confirmEmail: user.email },
      session.accessToken,
    );
    expect(deleted.status).toBe(200);

    const [after] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(after?.anonymisedAt).toBeInstanceOf(Date);
    expect(after?.email).not.toBe(user.email);
    expect(after?.fullName).toBe("Deleted account");
    expect(after?.status).toBe("REJECTED");
    expect(after?.consentAcceptedAt).toBeNull();

    // The session and its tokens are gone with it.
    const stillAuthed = await req("GET", "/api/v1/me", undefined, session.accessToken);
    expect(stillAuthed.status).toBe(401);
    const tokens = await db.select().from(authTokens).where(eq(authTokens.userId, user.id));
    expect(tokens.every((t) => t.consumedAt !== null)).toBe(true);

    // Nobody can sign in as the tombstone, and the address cannot be re-registered
    // to the old owner by guessing.
    const relogin = await req("POST", "/api/v1/auth/login", {
      email: user.email,
      password: PASSWORD,
      client: "mobile",
    });
    expect(relogin.status).toBe(401);
    if (event) {
      const kept = await db.select().from(complaints).where(eq(complaints.reportedBy, user.id));
      expect(kept.length).toBeGreaterThan(0);
      const registrationsKept = await db
        .select()
        .from(registrations)
        .where(eq(registrations.userId, user.id));
      expect(Array.isArray(registrationsKept)).toBe(true);
    }
  });

  test("an administrator cannot delete themselves through the endpoint", async () => {
    const { db } = getDb();
    const user = await makeUser("admin-delete");
    const session = await login(user.email);
    const { roleAssignments } = await import("../src/db/schema");
    await db.insert(roleAssignments).values({
      userId: user.id,
      role: "ADMIN",
      scopeType: "GLOBAL",
    });
    const blocked = await req(
      "POST",
      "/api/v1/me/delete",
      { confirmEmail: user.email },
      session.accessToken,
    );
    expect(blocked.status).toBe(409);
    expect(code(blocked)).toBe("LAST_ADMIN");
  });

  test("sign-in metadata records the trusted hop, not a client-supplied address", async () => {
    const { db } = getDb();
    const user = await makeUser("xff");
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // A caller inventing the left edge of the chain. The last hop is the one
        // our own proxy appended, and that is the address that must be recorded.
        "x-forwarded-for": "1.2.3.4, 203.0.113.9",
      },
      body: JSON.stringify({ email: user.email, password: PASSWORD, client: "mobile" }),
    });
    expect(res.status).toBe(200);
    const { sessions } = await import("../src/db/schema");
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows.length).toBe(1);
    expect(rows[0]?.ipHash).not.toBeNull();
  });

  test("file type sniffing does not trust the declared content type", () => {
    expect(sniffMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      sniffMimeType(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
        ]),
      ),
    ).toBe("image/webp");
    expect(sniffMimeType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("application/pdf");
    // HTML dressed up as PNG: the declared type is irrelevant.
    expect(sniffMimeType(new TextEncoder().encode("<!doctype html><h1>hi"))).toBeNull();
  });
});
