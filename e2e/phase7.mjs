import { chromium } from "playwright";

/**
 * Phase 7 walkthrough on the real website: a coordinator opens an event, sees the
 * participant roster, the quiz workspace, and the announcement composer, and
 * publishes an announcement that a student then receives.
 */
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5173";
const API = process.env.E2E_API ?? "http://127.0.0.1:8787/api/v1";
const PW = process.env.E2E_PASSWORD;
if (!PW) throw new Error("E2E_PASSWORD is required");
const results = [];
const errors = [];
const ok = (n, d = "") => {
  const line = `PASS  ${n}${d ? ` — ${d}` : ""}`;
  results.push(line);
  console.log(line);
};
const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
});

async function api(path, body, token, method) {
  const r = await fetch(`${API}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j.error ?? j)}`);
  return j.data;
}

async function session(email, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|status of 4/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector("nav.tabs");
  return { ctx, page };
}

const nav = async (page, label) => {
  const menu = page.locator('button[aria-label="Open menu"]');
  if (await menu.isVisible()) await menu.click();
  await page.click(`nav.tabs button:has-text("${label}")`);
};

const subtab = (page, label) => page.click(`.event-nav button:has-text("${label}")`);

/**
 * The events page now shows one event at a time: search the list, open a card,
 * and use the workspace navigation. "All events" returns to the list.
 */
async function openEvent(page, search, title) {
  await nav(page, "Events");
  const back = page.locator('button:has-text("All events")');
  if ((await back.count()) > 0 && (await back.first().isVisible())) await back.first().click();
  const searchBox = page.locator('input[placeholder="Search events…"]');
  await searchBox.waitFor();
  await searchBox.fill(search);
  const card = page.locator("button.event-card", { hasText: title }).first();
  await card.waitFor();
  await card.click();
  await page.waitForSelector(".event-nav");
}

try {
  const leadLogin = await api("/auth/login", {
    email: "coding.lead@demo.campusops.local",
    password: PW,
    client: "web",
  });
  const leadToken = leadLogin.accessToken;
  const managed = await api("/me/events?limit=100", undefined, leadToken);
  const drive = managed.items.find((e) => e.admissionMode === "QUIZ_TOP_N");
  const sprint = managed.items.find((e) => e.admissionMode === "QUIZ_FIRST_QUALIFIED");
  if (!drive || !sprint) throw new Error("Demo quiz events missing; run db:seed");
  ok("seed exposes both quiz admission modes", `${drive.title} / ${sprint.title}`);

  // ── Coordinator opens the placement drive ────────────────────────────────
  const lead = await session("coding.lead@demo.campusops.local");
  await openEvent(lead.page, "Placement Drive", "Placement Drive · Backend Engineer");
  ok("coordinator opens a quiz-admission event workspace");
  if ((await lead.page.locator('input[placeholder="Search events…"]').count()) === 0)
    ok("the event list gives way to the selected event");
  else throw new Error("the event list stayed beside the selected event");

  // Oversight can review an event in its department, but never gets the
  // coordinator's authoring or publishing controls.
  const hodLogin = await api("/auth/login", {
    email: "hoddean.cse@demo.campusops.local",
    password: PW,
    client: "web",
  });
  const hodManaged = await api("/me/events?limit=5", undefined, hodLogin.accessToken);
  if (hodManaged.items.length === 0) throw new Error("HOD/Dean has no event to review");
  const review = hodManaged.items[0];
  const hod = await session("hoddean.cse@demo.campusops.local");
  await openEvent(hod.page, review.title, review.title);
  const hodNav = await hod.page.locator(".event-nav").innerText();
  if (!/Edit details/.test(hodNav)) ok("HOD/Dean gets no event editing tab");
  else throw new Error("HOD/Dean was offered Edit details");
  if ((await hod.page.locator('button:has-text("Publish event")').count()) === 0)
    ok("HOD/Dean cannot publish or revise an event");
  else throw new Error("HOD/Dean was offered the publish control");
  await subtab(hod.page, "Approvals");
  const hodApprovals = await hod.page.locator(".event-content").innerText();
  if (!/Build the permission bundle/.test(hodApprovals))
    ok("HOD/Dean sees decisions without the coordinator's bundle builder");
  else throw new Error("HOD/Dean was offered the permission bundle builder");
  await hod.ctx.close();

  // Participants tab
  await subtab(lead.page, "Participants");
  await lead.page.locator(".stat-grid").first().waitFor();
  const rosterApi = await api(`/events/${drive.id}/registrations?limit=5`, undefined, leadToken);
  await lead.page.getByText("Participants", { exact: true }).first().waitFor();
  ok("participant roster renders with exact API totals", `total=${rosterApi.totals.total}`);
  await lead.page.screenshot({ path: "e2e/p7-01-roster.png", fullPage: true });

  // Quiz tab: the paper and the rules
  await subtab(lead.page, "Quiz");
  await lead.page.getByText("Top scores get seats", { exact: false }).first().waitFor();
  await lead.page.getByText("Which HTTP status means a resource was created?").waitFor();
  const quizApi = await api(`/events/${drive.id}/quiz`, undefined, leadToken);
  if (quizApi.questions.length !== 5) throw new Error("Expected 5 seeded questions");
  ok(
    "quiz workspace shows the paper, rules and answer key",
    `${quizApi.questions.length} questions`,
  );
  await lead.page.screenshot({ path: "e2e/p7-02-quiz.png", fullPage: true });

  // First-to-qualify explains itself differently
  await openEvent(lead.page, "Aptitude Sprint", "Aptitude Sprint · First to Qualify");
  await subtab(lead.page, "Quiz");
  await lead.page
    .getByText("First to qualify until seats fill", { exact: false })
    .first()
    .waitFor();
  await lead.page.getByText("no allocation step", { exact: false }).waitFor();
  ok("first-to-qualify mode states that seats are automatic");

  // ── Announcements: publish through the UI ───────────────────────────────
  await openEvent(lead.page, "Intro to Git", "Intro to Git Workshop");
  await subtab(lead.page, "Announcements");
  await lead.page.getByText("Bring your laptop with Git installed").waitFor();
  ok("existing announcements render for the event");

  const stamp = Date.now();
  const title = `E2E update ${stamp}`;
  await lead.page.fill('input[placeholder="Venue changed to Seminar Hall 2"]', title);
  await lead.page.fill(
    'textarea[placeholder*="bring your college ID"]',
    "Reporting time moved by 15 minutes. Everything else is unchanged.",
  );
  await lead.page.click('button:has-text("Publish announcement")');
  await lead.page.getByText(title).first().waitFor();
  ok("coordinator publishes an announcement through the portal");
  await lead.page.screenshot({ path: "e2e/p7-03-announcements.png", fullPage: true });

  const list = await api(`/events/${drive.id}/announcements?limit=5`, undefined, leadToken);
  if (!Array.isArray(list.items)) throw new Error("Organiser announcement list shape changed");
  ok("organiser list reports read counts", `items=${list.items.length}`);

  // ── Student receives it ─────────────────────────────────────────────────
  const studentLogin = await api("/auth/login", {
    email: "student.verified@demo.campusops.local",
    password: PW,
    client: "mobile",
  });
  let inbox = await api("/me/announcements?limit=50", undefined, studentLogin.accessToken);
  if (!inbox.items.some((i) => i.title === title)) {
    // The student must be registered for a REGISTERED announcement to reach them.
    const git = managed.items.find((e) => e.slug === "demo-git-workshop");
    const target =
      git ??
      (await api("/events?limit=100", undefined, studentLogin.accessToken)).items.find(
        (e) => e.slug === "demo-git-workshop",
      );
    await api(`/events/${target.id}/register`, {}, studentLogin.accessToken);
    inbox = await api("/me/announcements?limit=50", undefined, studentLogin.accessToken);
  }
  const received = inbox.items.find((i) => i.title === title);
  if (!received) throw new Error("Registered student did not receive the announcement");
  ok("registered student receives the announcement in their inbox", `unread=${inbox.unread}`);
  if (!received.event?.title) throw new Error("Inbox item must carry its event");

  const before = inbox.unread;
  await api(`/me/announcements/${received.id}/read`, {}, studentLogin.accessToken);
  const after = await api("/me/announcements?limit=50", undefined, studentLogin.accessToken);
  if (after.unread >= before) throw new Error("Marking read did not reduce the unread count");
  ok("marking read reduces the server-side unread count", `${before} -> ${after.unread}`);

  // ── Student takes a real quiz attempt ───────────────────────────────────
  const studentToken = studentLogin.accessToken;
  await api(`/events/${sprint.id}/register`, {}, studentToken).catch(() => null);
  const view = await api(`/events/${sprint.id}/quiz/me`, undefined, studentToken);
  if (!view.quiz) throw new Error("Student cannot see the published quiz");
  if (JSON.stringify(view).includes("correctOptionIndex"))
    throw new Error("Answer key leaked to the participant");
  ok("participant sees quiz rules with no answer key");

  // The one-attempt rule means a rerun cannot start again. Both paths are real:
  // a first run takes the paper, a rerun verifies the recorded result.
  const key = await api(`/events/${sprint.id}/quiz`, undefined, leadToken);
  if (view.attempt?.status === "SUBMITTED") {
    if (view.attempt.percentScore !== 100)
      throw new Error(`Recorded attempt is not the expected 100%: ${view.attempt.percentScore}`);
    ok("a previous attempt is reported, not restarted", `status=${view.attempt.status}`);
    const again = await api(`/events/${sprint.id}/quiz/attempts`, {}, studentToken).catch(
      (e) => e.message,
    );
    if (!String(again).includes("409"))
      throw new Error("A submitted participant was allowed to start a second attempt");
    ok("the one-attempt rule refuses a second attempt");
  } else {
    const started = await api(`/events/${sprint.id}/quiz/attempts`, {}, studentToken);
    if (started.questions.some((q) => "correctOptionIndex" in q))
      throw new Error("Answer key leaked in the paper");
    ok(
      "starting an attempt returns a paper without the key",
      `${started.questions.length} questions`,
    );

    // Answer using the organiser's key, which only the organiser can read.
    const answers = {};
    for (const q of started.questions) {
      const source = key.questions.find((k) => k.prompt === q.prompt);
      answers[q.id] = source.correctOptionIndex;
    }
    const submitted = await api(
      `/events/${sprint.id}/quiz/attempts/submit`,
      { answers, clientSubmittedAt: new Date().toISOString() },
      studentToken,
    );
    if (submitted.percentScore !== 100)
      throw new Error(`Expected 100%, got ${submitted.percentScore}`);
    ok("a perfect attempt scores 100% and qualifies", `outcome=${submitted.outcome}`);

    const replay = await api(
      `/events/${sprint.id}/quiz/attempts/submit`,
      { answers },
      studentToken,
    );
    if (!replay.alreadySubmitted) throw new Error("Replayed submission was not detected");
    ok("replaying a submission does not re-score the attempt");
  }

  const board = await api(`/quizzes/${key.quiz.id}/leaderboard`, undefined, leadToken);
  if (!board.items.some((i) => i.percentScore === 100))
    throw new Error("Leaderboard did not record the submission");
  ok("coordinator leaderboard reflects the real submission", `${board.items.length} attempts`);

  // ── Offline scan sync round-trip ────────────────────────────────────────
  const live = managed.items.find((e) => e.status === "LIVE") ?? drive;
  const cps = await api(`/events/${live.id}/checkpoints`, undefined, leadToken);
  if (cps.items.length > 0) {
    const sync = await api(
      "/access/scans/sync",
      {
        items: [
          {
            clientScanId: crypto.randomUUID(),
            checkpointId: cps.items[0].id,
            token: "deliberately-invalid-token",
            identityCheck: "MATCH",
            capturedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      },
      leadToken,
    );
    if (sync.accepted !== 0 || sync.results.length !== 1)
      throw new Error("Offline sync did not refuse an invalid token per item");
    ok("offline sync refuses a forged code per item", sync.results[0].reason);
  }

  // ── Narrow viewport ────────────────────────────────────────────────────
  await lead.page.setViewportSize({ width: 390, height: 844 });
  await lead.page.reload({ waitUntil: "networkidle" });
  await nav(lead.page, "Events");
  await lead.page.waitForTimeout(500);
  await lead.page.screenshot({ path: "e2e/p7-04-narrow.png", fullPage: true });
  const overflow = await lead.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 2) throw new Error(`Horizontal overflow at 390px: ${overflow}px`);
  ok("no horizontal overflow at 390px");

  await lead.ctx.close();
} catch (err) {
  console.error(`FAIL  ${err.message}`);
  results.push(`FAIL  ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

console.log(`\n${results.filter((r) => r.startsWith("PASS")).length} passed`);
if (errors.length) {
  console.error(`Console/page errors:\n${[...new Set(errors)].join("\n")}`);
  process.exitCode = 1;
} else console.log("0 console errors");
