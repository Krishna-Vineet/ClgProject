import { mkdirSync } from "node:fs";
import { chromium, firefox } from "playwright";

/** Real mobile-web bundle against the real API. Native camera hardware is not
 * simulated here; the paste-code path exercises the same scan/inspect contract. */
const BASE = process.env.E2E_MOBILE_BASE ?? "http://127.0.0.1:8081";
const API = process.env.E2E_API ?? "http://127.0.0.1:8787/api/v1";
const PW = process.env.E2E_PASSWORD;
if (!PW) throw new Error("E2E_PASSWORD is required");
const results = [];
const errors = [];
const ok = (name, detail = "") => {
  const line = `PASS  ${name}${detail ? ` — ${detail}` : ""}`;
  results.push(line);
  console.log(line);
};
const useFirefox = process.env.E2E_BROWSER === "firefox";
const browser = useFirefox
  ? await firefox.launch({
      ...(process.env.E2E_FIREFOX_PATH ? { executablePath: process.env.E2E_FIREFOX_PATH } : {}),
    })
  : await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
    });
mkdirSync("e2e", { recursive: true });
const stamp = Date.now();
async function api(path, body, token, method) {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}
async function login(email) {
  return api("/auth/login", { email, password: PW, client: "mobile" });
}
async function pageFor(session, width = 390) {
  const ctx = await browser.newContext({
    viewport: { width, height: 844 },
    isMobile: false,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !/Failed to load resource|status of 4|status of 5|camera|Camera|getUserMedia|NotFoundError/.test(
        m.text(),
      )
    )
      errors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByTestId("email").fill(session.user.email);
  await page.getByTestId("password").fill(PW);
  await page.getByTestId("auth-submit").click();
  await page.getByTestId("tab-events").waitFor({ timeout: 30000 });
  return { ctx, page };
}
const tab = (page, name) => page.getByTestId(`tab-${name}`).click();
try {
  const student = await login("student.verified@demo.campusops.local");
  const lead = await login("coding.lead@demo.campusops.local");
  const wallet = await api("/me/passes", undefined, student.accessToken);
  const pass = wallet.items.find((p) => p.event.title === "Demo One-Day Tech Fest");
  if (!pass) throw new Error("Seed the demo event first");
  const gate = pass.checkpoints.find((c) => c.name === "Main gate");
  const lunch = pass.checkpoints.find((c) => c.name === "Lunch");
  const books = pass.checkpoints.find((c) => c.name === "Book issue");
  // A free-form name created through the coordinator API must reach the phone.
  const customName = `xyz ${stamp}`;
  const custom = await api(
    `/events/${pass.event.id}/checkpoints`,
    { name: customName, qrType: "COUNTED", maxUses: 4, validityMode: "MANUAL" },
    lead.accessToken,
  );

  const s = await pageFor(student);
  await s.page.getByText("What's happening on campus").waitFor();
  ok("student signs in through the real mobile auth API");
  await s.page.getByTestId("tab-events").click();
  await s.page.getByText("Demo One-Day Tech Fest", { exact: true }).first().click();
  await s.page.getByText("Your registration", { exact: true }).waitFor();
  ok("event feed opens a real event detail with the student's registration");
  await s.page.screenshot({ path: "e2e/p5-01-event.png", fullPage: true });

  await tab(s.page, "passes");
  await s.page.getByText("Event passes", { exact: true }).waitFor();
  await s.page.getByRole("button", { name: "Demo One-Day Tech Fest", exact: true }).click();
  await s.page.getByRole("button", { name: customName, exact: true }).click();
  await s.page.getByText("4 left", { exact: true }).waitFor();
  await s.page.getByLabel("Rotating event pass QR code").waitFor();
  ok("coordinator-defined free-form QR name, counted limit and rotating code appear on the phone");
  await s.page.getByRole("button", { name: "Main gate", exact: true }).click();
  await s.page.getByText(/Next scan:/).waitFor();
  ok("toggle QR shows whether the next scan records entry or exit");
  await s.page.getByRole("button", { name: "Lunch", exact: true }).click();
  await s.page.getByText("This QR is switched off right now", { exact: true }).waitFor();
  ok("switch-only QR explains why it is unavailable instead of showing a working code");
  await s.page.screenshot({ path: "e2e/p5-02-passes.png", fullPage: true });

  // Organizer scanner: inspect first, attest identity, then commit.
  const l = await pageFor(lead);
  await tab(l.page, "scan");
  await l.page.getByRole("button", { name: "Check a participant", exact: true }).click();
  await l.page.getByRole("button", { name: "Demo One-Day Tech Fest", exact: true }).click();
  await l.page.getByRole("button", { name: customName, exact: true }).click();
  const nonce = await api(
    `/me/passes/${pass.passId}/nonce`,
    { checkpointId: custom.id },
    student.accessToken,
  );
  await l.page.getByLabel("QR contents").fill(nonce.token);
  await l.page.getByRole("button", { name: "Read code", exact: true }).click();
  await l.page.getByText("Confirm the person in front of you").waitFor();
  await l.page.getByText(student.user.fullName, { exact: true }).waitFor();
  ok("organiser scanner resolves the real pass holder before recording a use");
  await l.page.getByRole("button", { name: "ID matches — record scan", exact: true }).click();
  await l.page.getByText("Access granted", { exact: true }).waitFor();
  await l.page.getByText("3 uses left", { exact: true }).waitFor();
  ok("identity-confirmed scan records exactly one counted use");
  await l.page.screenshot({ path: "e2e/p5-03-scan.png", fullPage: true });

  // Participant scans a complaint location QR (paste path uses the same parser).
  const locations = await api(
    `/events/${pass.event.id}/complaint-locations`,
    undefined,
    lead.accessToken,
  );
  const location = locations.items[0];
  await tab(s.page, "scan");
  await s.page.getByLabel("QR contents").fill(`campusops://complaint/${location.id}`);
  await s.page.getByRole("button", { name: "Read code", exact: true }).click();
  await s.page.getByText("Report an issue", { exact: true }).waitFor();
  await s.page.getByLabel("Describe the issue").fill(`Mobile E2E sound issue ${stamp}`);
  await s.page.getByTestId("send-complaint").click();
  await s.page.getByText(`Mobile E2E sound issue ${stamp}`, { exact: true }).waitFor();
  ok("participant scans a location QR, submits a complaint and sees it in their own issue list");
  await s.page.screenshot({ path: "e2e/p5-04-help.png", fullPage: true });

  await tab(s.page, "profile");
  await s.page.getByText("Student profile", { exact: true }).waitFor();
  if (await s.page.getByRole("button", { name: "Save profile", exact: true }).count())
    throw new Error("Student profile edit must not exist");
  ok("student profile is read-only; password and session controls are present");
  await s.page.getByRole("button", { name: "Change password", exact: true }).waitFor();
  await s.page.screenshot({ path: "e2e/p5-05-profile.png", fullPage: true });

  const overflow = await s.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow > 1) throw new Error(`Mobile overflow ${overflow}px`);
  ok("390px viewport has no horizontal overflow");
  // Registration form is reachable without an account and loads real departments.
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const a = await anon.newPage();
  a.setDefaultTimeout(15000);
  a.on("pageerror", (e) => errors.push(e.message));
  await a.goto(BASE, { waitUntil: "networkidle" });
  await a.getByRole("button", { name: "College student", exact: true }).click();
  await a.getByLabel("College ID number", { exact: true }).waitFor();
  await a.getByRole("button", { name: "Computer Science", exact: false }).first().waitFor();
  ok("college registration collects college ID and real department choices");
  await a.getByRole("button", { name: "Outside student", exact: true }).click();
  if (await a.getByLabel("College ID number", { exact: true }).count())
    throw new Error("Outsider form leaked college fields");
  ok("outsider registration is separate and does not ask for faculty verification fields");
  // ── Phase 7: announcements inbox ─────────────────────────────────────────
  await tab(s.page, "inbox");
  await s.page.getByText("Announcements", { exact: true }).first().waitFor();
  const inbox = await api("/me/announcements?limit=50", undefined, student.accessToken);
  if (inbox.items.length === 0) throw new Error("Expected seeded announcements");
  await s.page.getByText(inbox.items[0].title, { exact: false }).first().waitFor();
  ok("updates tab shows the participant's real announcement inbox", `${inbox.items.length} items`);
  await s.page.screenshot({ path: "e2e/p7-m01-inbox.png", fullPage: true });

  // Reading marks it read on the server, not just locally.
  const unreadItem = inbox.items.find((i) => !i.readAt);
  if (unreadItem) {
    await s.page.getByTestId(`announcement-${unreadItem.id}`).click();
    await s.page.waitForTimeout(600);
    const after = await api("/me/announcements?limit=50", undefined, student.accessToken);
    const now = after.items.find((i) => i.id === unreadItem.id);
    if (!now?.readAt) throw new Error("Opening an announcement did not mark it read");
    ok("opening an announcement records the read on the server");
  }

  // ── Phase 7: quiz screen ────────────────────────────────────────────────
  await tab(s.page, "events");
  await s.page.getByText("Aptitude Sprint · First to Qualify", { exact: true }).first().click();
  await s.page.getByTestId("open-quiz").click();
  await s.page.getByText("How this quiz works", { exact: true }).waitFor();
  await s.page.getByText("First to reach the pass mark, until full", { exact: false }).waitFor();
  ok("quiz screen explains the seat rule and shows the participant's own state");
  await s.page.screenshot({ path: "e2e/p7-m02-quiz.png", fullPage: true });
  // The paper must never be reachable with an answer key on the phone.
  const quizView = await api(
    `/events/${(await api("/events?limit=100", undefined, student.accessToken)).items.find((e) => e.slug === "demo-aptitude-sprint").id}/quiz/me`,
    undefined,
    student.accessToken,
  );
  if (JSON.stringify(quizView).includes("correctOptionIndex"))
    throw new Error("Answer key present in the participant payload");
  ok("participant payload carries no answer key");
  await s.page.getByRole("button", { name: "Back to event", exact: true }).click();

  // ── Phase 7: offline queue survives a reload ────────────────────────────
  await tab(l.page, "scan");
  await l.page.getByRole("button", { name: "Check a participant", exact: true }).click();
  await l.page.getByRole("button", { name: "Demo One-Day Tech Fest", exact: true }).click();
  await l.page.getByRole("button", { name: "Main gate", exact: true }).click();
  const gateNonce = await api(
    `/me/passes/${pass.passId}/nonce`,
    { checkpointId: gate.id },
    student.accessToken,
  );
  // Inspect while online, then lose signal before recording: exactly what
  // happens when the network drops as someone walks through the gate.
  await l.page.getByLabel("QR contents", { exact: true }).fill(gateNonce.token);
  await l.page.getByRole("button", { name: "Read code", exact: true }).click();
  await l.page.getByText("Confirm the person in front of you").waitFor();
  await l.ctx.setOffline(true);
  await l.page.getByRole("button", { name: "ID matches — record scan", exact: true }).click();
  await l.page.getByText("Saved on this phone", { exact: false }).waitFor({ timeout: 20000 });
  ok("a scan recorded with no network is kept on the phone, not lost");
  await l.ctx.setOffline(false);
  await l.page.getByText(/scan\(s\) waiting to sync/).waitFor({ timeout: 15000 });
  await l.page.screenshot({ path: "e2e/p7-m03-offline.png", fullPage: true });

  // Reload proves the queue is durable storage, not just React state.
  await l.page.reload({ waitUntil: "networkidle" });
  await tab(l.page, "scan");
  await l.page.getByRole("button", { name: "Check a participant", exact: true }).click();
  await l.page.getByText(/scan\(s\) waiting to sync/).waitFor({ timeout: 20000 });
  ok("the queued scan survives an app reload");

  await l.page.getByTestId("sync-queue").click();
  await l.page
    .getByText(/recorded/, { exact: false })
    .first()
    .waitFor({ timeout: 25000 });
  ok("syncing the queue records the scan on the server");
  const log = await api(
    `/events/${pass.event.id}/access-log?limit=10`,
    undefined,
    lead.accessToken,
  );
  if (!log.items.some((i) => i.syncedOffline))
    throw new Error("Synced scan was not attributed as offline");
  ok("the server records it as an offline-synced scan");

  await anon.close();
  await s.ctx.close();
  await l.ctx.close();
} catch (err) {
  const line = `FAIL  ${err instanceof Error ? err.stack : String(err)}`;
  results.push(line);
  console.log(line);
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(
    `\n${results.filter((r) => r.startsWith("PASS")).length} pass, ${results.filter((r) => r.startsWith("FAIL")).length} fail; console/page errors: ${errors.length}`,
  );
  for (const e of errors) console.log(`ERROR ${e}`);
  if (results.some((r) => r.startsWith("FAIL")) || errors.length) process.exitCode = 1;
}
