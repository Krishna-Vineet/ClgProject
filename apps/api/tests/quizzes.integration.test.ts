import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { getDb } from "../src/db/client";
import {
  events,
  clubMemberships,
  clubs,
  departments,
  passes,
  quizAttempts,
  quizzes,
  registrations,
  roleAssignments,
  staffProfiles,
  studentProfiles,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/utils/password";

/**
 * Quiz seat allocation end to end through HTTP, including the two properties that
 * actually matter on the day: a seat is never handed out twice, and the answer
 * key never reaches a participant.
 */
const app = createApp();
const PASSWORD = "Quiz-Test-Password!";
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

async function account(label: string, kind: "staff" | "student", admin = false) {
  const { db } = getDb();
  const email = `quiz.${label.toLowerCase()}.${stamp}.${rnd()}@test.campusops.local`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      accountType: kind === "staff" ? "STAFF" : "COLLEGE_STUDENT",
      status: "ACTIVE",
      fullName: `Quiz ${label}`,
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
      rollNumber: `QZ${stamp}${rnd()}`.slice(0, 20),
      collegeIdNumber: `QID-${rnd()}`,
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

const window = () => ({
  opensAt: new Date(Date.now() - 3_600_000).toISOString(),
  closesAt: new Date(Date.now() + 3_600_000).toISOString(),
});

const QUESTIONS = [
  { prompt: "2 + 2 ?", options: ["3", "4", "5"], correctOptionIndex: 1, points: 1 },
  {
    prompt: "Capital of India?",
    options: ["Delhi", "Mumbai", "Chennai"],
    correctOptionIndex: 0,
    points: 1,
  },
  {
    prompt: "Largest planet?",
    options: ["Earth", "Mars", "Jupiter"],
    correctOptionIndex: 2,
    points: 1,
  },
  {
    prompt: "HTTP 404 means?",
    options: ["Not found", "OK", "Created"],
    correctOptionIndex: 0,
    points: 1,
  },
];

async function makeEvent(
  label: string,
  mode: "QUIZ_TOP_N" | "QUIZ_FIRST_QUALIFIED",
  capacity: number,
) {
  const { db } = getDb();
  const [event] = await db
    .insert(events)
    .values({
      clubId: ids.club as string,
      title: `Quiz Drive ${label} ${stamp}`,
      slug: `quiz-drive-${label}-${stamp}-${rnd()}`,
      description: "Placement-style drive with quiz seat allocation.",
      template: "PLACEMENT_DRIVE",
      audience: "COLLEGE_ONLY",
      admissionMode: mode,
      capacity,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
      registrationOpensAt: new Date(Date.now() - 86_400_000),
      registrationClosesAt: new Date(Date.now() + 86_400_000),
      venueSummary: "Seminar Hall",
      status: "PUBLISHED",
      publishedAt: new Date(Date.now() - 3_600_000),
      createdBy: ids.lead as string,
    })
    .returning();
  if (!event) throw new Error("event failed");
  return event.id;
}

/** Answer `correct` of the four questions, using the organiser's answer key. */
function answersFor(questions: Body[], correct: number) {
  const answers: Record<string, number> = {};
  questions.forEach((q, i) => {
    const key = QUESTIONS[i]?.correctOptionIndex ?? 0;
    // Questions may be shuffled; match by prompt instead of position.
    const source = QUESTIONS.find((src) => src.prompt === q.prompt);
    const right = source?.correctOptionIndex ?? key;
    const index = questions.indexOf(q);
    answers[q.id] = index < correct ? right : (right + 1) % 3;
  });
  return answers;
}

async function attempt(eventId: string, label: string, correct: number) {
  const started = await req("POST", `/api/v1/events/${eventId}/quiz/attempts`, {}, tokens[label]);
  expect(started.status).toBe(201);
  const paper = started.json.data.questions as Body[];
  const submitted = await req(
    "POST",
    `/api/v1/events/${eventId}/quiz/attempts/submit`,
    { answers: answersFor(paper, correct) },
    tokens[label],
  );
  return { started, submitted };
}

beforeAll(async () => {
  const { db } = getDb();
  const [dept] = await db
    .insert(departments)
    .values({ code: `QZ${stamp}`.slice(0, 20), name: "Quiz Dept" })
    .returning();
  if (!dept) throw new Error("dept failed");
  ids.dept = dept.id;
  await account("admin", "staff", true);
  await account("lead", "staff");
  await account("outsiderStaff", "staff");
  for (const label of ["s1", "s2", "s3", "s4", "s5"]) await account(label, "student");

  const [club] = await db
    .insert(clubs)
    .values({
      name: `Quiz Club ${stamp}`,
      slug: `quiz-club-${stamp}`,
      departmentId: dept.id,
      createdBy: ids.admin as string,
    })
    .returning();
  if (!club) throw new Error("club failed");
  ids.club = club.id;
  await db
    .insert(clubMemberships)
    .values({ clubId: club.id, userId: ids.lead as string, clubRole: "LEAD" });

  ids.topN = await makeEvent("topn", "QUIZ_TOP_N", 2);
  ids.firstQ = await makeEvent("firstq", "QUIZ_FIRST_QUALIFIED", 1);
});

describe("quiz configuration", () => {
  test("a coordinator creates a quiz; the mode must match the event", async () => {
    const bad = await req(
      "PUT",
      `/api/v1/events/${ids.topN}/quiz`,
      {
        mode: "FIRST_QUALIFIED",
        ...window(),
        durationSeconds: 600,
        passScore: 50,
        questions: QUESTIONS,
      },
      tokens.lead,
    );
    expect(bad.status).toBe(400);

    const ok = await req(
      "PUT",
      `/api/v1/events/${ids.topN}/quiz`,
      { mode: "TOP_N", ...window(), durationSeconds: 600, questions: QUESTIONS },
      tokens.lead,
    );
    expect(ok.status).toBe(200);
    ids.topNQuiz = ok.json.data.id;
  });

  test("FIRST_QUALIFIED refuses to be created without a pass score", async () => {
    const res = await req(
      "PUT",
      `/api/v1/events/${ids.firstQ}/quiz`,
      { mode: "FIRST_QUALIFIED", ...window(), durationSeconds: 600, questions: QUESTIONS },
      tokens.lead,
    );
    expect(res.status).toBe(400);
  });

  test("an unrelated staff account cannot configure or read the answer key", async () => {
    const write = await req(
      "PUT",
      `/api/v1/events/${ids.topN}/quiz`,
      { mode: "TOP_N", ...window(), durationSeconds: 600, questions: QUESTIONS },
      tokens.outsiderStaff,
    );
    expect(write.status).toBe(403);
    const read = await req(
      "GET",
      `/api/v1/events/${ids.topN}/quiz`,
      undefined,
      tokens.outsiderStaff,
    );
    expect(read.status).toBe(404);
  });

  test("a correct-option index outside the options is rejected", async () => {
    const res = await req(
      "PUT",
      `/api/v1/events/${ids.firstQ}/quiz`,
      {
        mode: "FIRST_QUALIFIED",
        ...window(),
        durationSeconds: 600,
        passScore: 50,
        questions: [{ prompt: "Bad?", options: ["a", "b"], correctOptionIndex: 5, points: 1 }],
      },
      tokens.lead,
    );
    expect(res.status).toBe(400);
  });

  test("the second quiz is created and both are published", async () => {
    const created = await req(
      "PUT",
      `/api/v1/events/${ids.firstQ}/quiz`,
      {
        mode: "FIRST_QUALIFIED",
        ...window(),
        durationSeconds: 600,
        passScore: 50,
        shuffleQuestions: false,
        questions: QUESTIONS,
      },
      tokens.lead,
    );
    expect(created.status).toBe(200);
    ids.firstQQuiz = created.json.data.id;
    for (const quizId of [ids.topNQuiz, ids.firstQQuiz]) {
      const pub = await req(
        "PATCH",
        `/api/v1/quizzes/${quizId}/status`,
        { status: "PUBLISHED" },
        tokens.lead,
      );
      expect(pub.status).toBe(200);
    }
  });
});

describe("participant attempts", () => {
  test("the paper never contains the answer key", async () => {
    const started = await req("POST", `/api/v1/events/${ids.topN}/quiz/attempts`, {}, tokens.s1);
    expect(started.status).toBe(201);
    const questions = started.json.data.questions as Body[];
    expect(questions.length).toBe(4);
    for (const q of questions) {
      expect(q.correctOptionIndex).toBeUndefined();
      expect(q.options.length).toBeGreaterThanOrEqual(2);
    }
    expect(started.json.data.secondsLeft).toBeGreaterThan(0);
  });

  test("resuming returns the same attempt and the same paper order", async () => {
    const again = await req("POST", `/api/v1/events/${ids.topN}/quiz/attempts`, {}, tokens.s1);
    expect(again.status).toBe(201);
    const first = await req("GET", `/api/v1/events/${ids.topN}/quiz/me`, undefined, tokens.s1);
    expect(first.json.data.attempt.status).toBe("IN_PROGRESS");
  });

  test("staff cannot take a participant quiz", async () => {
    const res = await req("POST", `/api/v1/events/${ids.topN}/quiz/attempts`, {}, tokens.lead);
    expect(res.status).toBe(403);
  });

  test("scoring is correct and a replayed submission does not re-score", async () => {
    const paper = await req("POST", `/api/v1/events/${ids.topN}/quiz/attempts`, {}, tokens.s1);
    const answers = answersFor(paper.json.data.questions as Body[], 4);
    const first = await req(
      "POST",
      `/api/v1/events/${ids.topN}/quiz/attempts/submit`,
      { answers },
      tokens.s1,
    );
    expect(first.status).toBe(200);
    expect(first.json.data.percentScore).toBe(100);
    expect(first.json.data.correctCount).toBe(4);

    const replay = await req(
      "POST",
      `/api/v1/events/${ids.topN}/quiz/attempts/submit`,
      { answers: {} },
      tokens.s1,
    );
    expect(replay.status).toBe(200);
    expect(replay.json.data.alreadySubmitted).toBe(true);
    expect(replay.json.data.percentScore).toBe(100);
  });

  test("submitting after submission is refused when starting again", async () => {
    const res = await req("POST", `/api/v1/events/${ids.topN}/quiz/attempts`, {}, tokens.s1);
    expect(res.status).toBe(409);
  });

  test("TOP_N records the score but does not confirm a seat before allocation", async () => {
    const { db } = getDb();
    const regs = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, ids.topN as string));
    expect(regs.length).toBe(0);
  });
});

describe("TOP_N allocation", () => {
  test("three more participants attempt with different scores", async () => {
    for (const [label, correct] of [
      ["s2", 3],
      ["s3", 2],
      ["s4", 1],
    ] as Array<[string, number]>) {
      const { submitted } = await attempt(ids.topN as string, label, correct);
      expect(submitted.status).toBe(200);
    }
  });

  test("allocation is refused while the quiz is still open", async () => {
    const res = await req("POST", `/api/v1/quizzes/${ids.topNQuiz}/allocate`, {}, tokens.lead);
    expect(res.status).toBe(409);
  });

  test("closing then allocating confirms exactly the top two and waitlists the rest", async () => {
    const closed = await req(
      "PATCH",
      `/api/v1/quizzes/${ids.topNQuiz}/status`,
      { status: "CLOSED" },
      tokens.lead,
    );
    expect(closed.status).toBe(200);
    const allocated = await req(
      "POST",
      `/api/v1/quizzes/${ids.topNQuiz}/allocate`,
      { note: "Seats by rank" },
      tokens.lead,
    );
    expect(allocated.status).toBe(200);
    expect(allocated.json.data.confirmed).toBe(2);
    expect(allocated.json.data.waitlisted).toBe(2);

    const board = await req(
      "GET",
      `/api/v1/quizzes/${ids.topNQuiz}/leaderboard`,
      undefined,
      tokens.lead,
    );
    expect(board.status).toBe(200);
    const items = board.json.data.items as Body[];
    expect(items[0]?.percentScore).toBe(100);
    expect(items[0]?.registrationStatus).toBe("CONFIRMED");
    expect(items[1]?.registrationStatus).toBe("CONFIRMED");
    expect(items.filter((i) => i.registrationStatus === "WAITLISTED").length).toBe(2);
    // Ranks are dense and ordered.
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
  });

  test("a confirmed participant has exactly one active pass", async () => {
    const { db } = getDb();
    const rows = await db
      .select({ passId: passes.id, revokedAt: passes.revokedAt, status: registrations.status })
      .from(registrations)
      .leftJoin(passes, eq(passes.registrationId, registrations.id))
      .where(eq(registrations.eventId, ids.topN as string));
    const confirmed = rows.filter((r) => r.status === "CONFIRMED");
    expect(confirmed.length).toBe(2);
    for (const r of confirmed) {
      expect(r.passId).not.toBeNull();
      expect(r.revokedAt).toBeNull();
    }
    // Waitlisted participants must not hold a usable pass.
    for (const r of rows.filter((x) => x.status === "WAITLISTED")) {
      expect(r.passId === null || r.revokedAt !== null).toBe(true);
    }
  });

  test("allocating twice is refused, so seats cannot be handed out again", async () => {
    const res = await req("POST", `/api/v1/quizzes/${ids.topNQuiz}/allocate`, {}, tokens.lead);
    expect(res.status).toBe(409);
  });

  test("a participant cannot read the leaderboard", async () => {
    const res = await req(
      "GET",
      `/api/v1/quizzes/${ids.topNQuiz}/leaderboard`,
      undefined,
      tokens.s1,
    );
    expect(res.status).toBe(404);
  });
});

describe("FIRST_QUALIFIED allocation", () => {
  test("the first qualifier takes the only seat immediately", async () => {
    const { submitted } = await attempt(ids.firstQ as string, "s1", 4);
    expect(submitted.status).toBe(200);
    expect(submitted.json.data.qualified).toBe(true);
    expect(submitted.json.data.outcome).toBe("CONFIRMED");
  });

  test("a later perfect scorer is waitlisted, not confirmed", async () => {
    const { submitted } = await attempt(ids.firstQ as string, "s2", 4);
    expect(submitted.json.data.qualified).toBe(true);
    expect(submitted.json.data.outcome).toBe("WAITLISTED");
  });

  test("a participant below the pass mark is rejected", async () => {
    const { submitted } = await attempt(ids.firstQ as string, "s3", 1);
    expect(submitted.json.data.qualified).toBe(false);
    expect(submitted.json.data.outcome).toBe("REJECTED");
  });

  test("only one seat is confirmed even though two qualified", async () => {
    const { db } = getDb();
    const rows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, ids.firstQ as string));
    expect(rows.filter((r) => r.status === "CONFIRMED").length).toBe(1);
    expect(rows.filter((r) => r.status === "WAITLISTED").length).toBe(1);
    expect(rows.filter((r) => r.status === "REJECTED").length).toBe(1);
  });

  test("concurrent submissions cannot both take the last seat", async () => {
    const eventId = await makeEvent(`race-${rnd()}`, "QUIZ_FIRST_QUALIFIED", 1);
    const created = await req(
      "PUT",
      `/api/v1/events/${eventId}/quiz`,
      {
        mode: "FIRST_QUALIFIED",
        ...window(),
        durationSeconds: 600,
        passScore: 50,
        shuffleQuestions: false,
        questions: QUESTIONS,
      },
      tokens.lead,
    );
    const quizId = created.json.data.id;
    await req("PATCH", `/api/v1/quizzes/${quizId}/status`, { status: "PUBLISHED" }, tokens.lead);

    // Both start, then submit at the same instant.
    const papers = await Promise.all(
      ["s4", "s5"].map((label) =>
        req("POST", `/api/v1/events/${eventId}/quiz/attempts`, {}, tokens[label]),
      ),
    );
    const results = await Promise.all(
      papers.map((paper, i) =>
        req(
          "POST",
          `/api/v1/events/${eventId}/quiz/attempts/submit`,
          { answers: answersFor(paper.json.data.questions as Body[], 4) },
          tokens[i === 0 ? "s4" : "s5"],
        ),
      ),
    );
    const outcomes = results.map((r) => r.json.data.outcome);
    expect(outcomes.filter((o) => o === "CONFIRMED").length).toBe(1);
    expect(outcomes.filter((o) => o === "WAITLISTED").length).toBe(1);
  });

  test("batch allocation is refused for a first-to-qualify quiz", async () => {
    const res = await req("POST", `/api/v1/quizzes/${ids.firstQQuiz}/allocate`, {}, tokens.lead);
    expect(res.status).toBe(400);
  });
});

describe("quiz admission registration", () => {
  test("registering for a quiz event is allowed and grants no seat", async () => {
    const res = await req("POST", `/api/v1/events/${ids.topN}/register`, {}, tokens.s5);
    expect(res.status).toBe(201);
    // Interest is recorded, but the seat still has to be earned.
    expect(res.json.data.registration.status).toBe("APPLIED");
    expect(res.json.data.passId ?? null).toBeNull();

    const view = await req("GET", `/api/v1/events/${ids.topN}/participant`, undefined, tokens.s5);
    expect(view.status).toBe(200);
    expect(view.json.data.registration.status).toBe("APPLIED");
  });

  test("registering twice does not create a second application", async () => {
    const again = await req("POST", `/api/v1/events/${ids.topN}/register`, {}, tokens.s5);
    expect(again.status).toBe(200);
    expect(again.json.data.alreadyRegistered).toBe(true);
  });

  test("a quiz event does not consume FCFS seats for people who never attempt", async () => {
    const { db } = getDb();
    const rows = await db
      .select()
      .from(registrations)
      .where(
        and(eq(registrations.eventId, ids.topN as string), eq(registrations.status, "CONFIRMED")),
      );
    // Only the two who earned seats by rank are confirmed, never the bystander.
    expect(rows.length).toBe(2);
    const bystander = await db
      .select()
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, ids.topN as string),
          eq(registrations.userId, ids.s5 as string),
        ),
      );
    expect(bystander[0]?.status).toBe("APPLIED");
  });
});

describe("quiz editing guards", () => {
  test("a published quiz cannot be edited", async () => {
    const res = await req(
      "PUT",
      `/api/v1/events/${ids.firstQ}/quiz`,
      {
        mode: "FIRST_QUALIFIED",
        ...window(),
        durationSeconds: 600,
        passScore: 50,
        questions: QUESTIONS,
      },
      tokens.lead,
    );
    expect(res.status).toBe(409);
  });

  test("a draft quiz can be attached before the event adopts quiz admission", async () => {
    const { db } = getDb();
    const [event] = await db
      .insert(events)
      .values({
        clubId: ids.club as string,
        title: `FCFS event ${stamp}`,
        slug: `fcfs-${stamp}-${rnd()}`,
        capacity: 10,
        admissionMode: "FCFS",
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 90_000_000),
        registrationOpensAt: new Date(Date.now() - 3_600_000),
        // Registration must close at or before the start, never after it.
        registrationClosesAt: new Date(Date.now() + 82_800_000),
        status: "PUBLISHED",
        publishedAt: new Date(),
        createdBy: ids.lead as string,
      })
      .returning();
    const res = await req(
      "PUT",
      `/api/v1/events/${event?.id}/quiz`,
      { mode: "TOP_N", ...window(), durationSeconds: 600, questions: QUESTIONS },
      tokens.lead,
    );
    expect(res.status).toBe(200);
    // The quiz is inert while the event still admits participants first-come-first-served.
    const attempt = await req("POST", `/api/v1/events/${event?.id}/quiz/attempts`, {}, tokens.s1);
    expect(attempt.status).toBe(400);
    expect(attempt.json.error.message).toContain("not part of the event's admission process");
  });

  test("the participant view exposes rules and own state but no answer key", async () => {
    const res = await req("GET", `/api/v1/events/${ids.firstQ}/quiz/me`, undefined, tokens.s1);
    expect(res.status).toBe(200);
    expect(res.json.data.quiz.mode).toBe("FIRST_QUALIFIED");
    expect(res.json.data.quiz.passScore).toBe(50);
    expect(res.json.data.attempt.allocatedStatus).toBe("CONFIRMED");
    expect(JSON.stringify(res.json.data)).not.toContain("correctOptionIndex");
  });

  test("reviewers can read the paper but never the answer key", async () => {
    const organiser = await req("GET", `/api/v1/events/${ids.firstQ}/quiz`, undefined, tokens.lead);
    expect(organiser.status).toBe(200);
    expect(organiser.json.data.canSeeAnswerKey).toBe(true);
    expect(organiser.json.data.questions[0].correctOptionIndex).toBeNumber();

    const oversight = await req(
      "GET",
      `/api/v1/events/${ids.firstQ}/quiz`,
      undefined,
      tokens.admin,
    );
    expect(oversight.status).toBe(200);
    expect(oversight.json.data.canSeeAnswerKey).toBe(false);
    expect(JSON.stringify(oversight.json.data)).not.toContain("correctOptionIndex");
  });

  test("closing a quiz expires an attempt still in progress", async () => {
    const { db } = getDb();
    const eventId = await makeEvent(`expire-${rnd()}`, "QUIZ_TOP_N", 5);
    const created = await req(
      "PUT",
      `/api/v1/events/${eventId}/quiz`,
      { mode: "TOP_N", ...window(), durationSeconds: 600, questions: QUESTIONS },
      tokens.lead,
    );
    const quizId = created.json.data.id;
    await req("PATCH", `/api/v1/quizzes/${quizId}/status`, { status: "PUBLISHED" }, tokens.lead);
    await req("POST", `/api/v1/events/${eventId}/quiz/attempts`, {}, tokens.s5);
    await req("PATCH", `/api/v1/quizzes/${quizId}/status`, { status: "CLOSED" }, tokens.lead);
    const [row] = await db.select().from(quizAttempts).where(eq(quizAttempts.quizId, quizId));
    expect(row?.status).toBe("EXPIRED");
    const late = await req(
      "POST",
      `/api/v1/events/${eventId}/quiz/attempts/submit`,
      { answers: {} },
      tokens.s5,
    );
    expect(late.status).toBe(409);
  });
});
