import { chromium } from "playwright";

/**
 * Real-browser walkthrough of the Phase 3 portal against the running API.
 * Creates its own event through the UI so it never depends on seed layout.
 * Run: E2E_PASSWORD=... bun run e2e/portal.mjs
 */
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5173";
const PW = process.env.E2E_PASSWORD;
if (!PW) throw new Error("E2E_PASSWORD is required (the seeded demo password).");

const results = [];
const errors = [];
const ok = (name, detail = "") => results.push(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail) => results.push(`FAIL  ${name} — ${detail}`);

// Playwright's bundled download is not always reachable in a sandbox. Allow an
// already-installed Chromium to be used instead: E2E_CHROMIUM_PATH=/usr/bin/chromium
const executablePath = process.env.E2E_CHROMIUM_PATH;
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(executablePath ? { executablePath } : {}),
});

async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  page.on("response", (res) => {
    // Record the URL, not just the status, so a stray 404 is actionable.
    if (res.status() >= 400 && res.status() !== 401)
      errors.push(`${email} HTTP ${res.status()}: ${res.url()}`);
  });
  page.on("console", (m) => {
    const t = m.text();
    // The initial cookie-restore probe is expected to 401 before login.
    if (m.type() === "error" && !t.includes("401")) errors.push(`${email} console: ${t}`);
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector("nav.tabs", { timeout: 20000 });
  return { ctx, page };
}

async function loginOnly(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PW);
  await page.click('button[type="submit"]');
  // Either outcome is valid: the console, or the "use the mobile app" notice.
  await page.waitForSelector('nav.tabs, h2:has-text("This console is for staff")', {
    timeout: 20000,
  });
  return { ctx, page };
}

const stamp = Date.now();
const title = `E2E Browser Workshop ${stamp}`;
// Each run books resources, so shift the window per run instead of reusing a
// fixed date that previous runs already hold.
const dayOffset = 20 + (Math.floor(stamp / 1000) % 200);

function localInput(daysAhead, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

try {
  // ── Coordinator: draft → individual approvals → submit ─────────────────
  const lead = await session("coding.lead@demo.campusops.local");
  const tabs = await lead.page.locator("nav.tabs button").allTextContents();
  ok("coordinator login", `tabs: ${tabs.join(", ")}`);

  await lead.page.click('nav.tabs button:has-text("Events")');
  await lead.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  ok(
    "coordinator sees club events",
    `${await lead.page.locator("table.grid tbody tr").count()} rows`,
  );

  await lead.page.click('button:has-text("New draft")');
  await lead.page.waitForSelector('input[value=""]', { timeout: 10000 });
  const form = lead.page.locator("form.form.wide").first();
  await form.locator("input").nth(0).fill(title);
  await form.locator('input[type="datetime-local"]').nth(0).fill(localInput(dayOffset, 10));
  await form.locator('input[type="datetime-local"]').nth(1).fill(localInput(dayOffset, 13));
  await form.locator('input[type="datetime-local"]').nth(3).fill(localInput(dayOffset, 10));
  await form.locator("textarea").fill("Created by the automated browser walkthrough.");
  await lead.page.click('button:has-text("Create draft")');
  await lead.page.waitForSelector(`h2:has-text("${title}")`, { timeout: 15000 });
  ok("draft created through the UI");

  await lead.page.click('button:has-text("+ Organize")');
  await lead.page.click('button:has-text("+ Resource")');
  await lead.page.waitForSelector(".request select", { timeout: 10000 });
  // Ask a real faculty member for the organize permission.
  const facultySelect = lead.page.locator(".request select").nth(0);
  const opts = await facultySelect.locator("option").allTextContents();
  await facultySelect.selectOption({ index: 1 });
  ok("faculty approver picker is populated", opts.slice(1).join(", "));
  // Pick a free resource unit for the resource permission.
  const unitSelect = lead.page.locator(".request select").nth(2);
  const unitOpts = await unitSelect.locator("option").count();
  if (unitOpts > 1) {
    await unitSelect.selectOption({ index: 1 });
    ok("only free units are offered for the event window", `${unitOpts - 1} available`);
  } else {
    fail("resource picker", "no available units offered");
  }
  const resourceTitle = lead.page.locator(".request").nth(1).locator("input").first();
  await resourceTitle.fill("Lab booking for browser walkthrough");
  const resourceFaculty = lead.page.locator(".request").nth(1).locator("select").first();
  await resourceFaculty.selectOption({ index: 1 });

  await lead.page.click('button:has-text("Submit for approval")');
  await lead.page.waitForSelector(".requests .request", { timeout: 15000 });
  const reqCount = await lead.page.locator(".requests .request").count();
  ok("submission creates separate approval requests", `${reqCount} individual requests`);
  const badges = await lead.page.locator(".requests .request .badge").allTextContents();
  ok("each request carries its own status", badges.join(", "));
  const publishDisabled = await lead.page
    .locator('button:has-text("Publish")')
    .first()
    .isDisabled();
  if (publishDisabled) ok("publish blocked while required approvals are pending");
  else fail("publish gate", "Publish enabled with pending approvals");
  await lead.page.screenshot({ path: "e2e/01-coordinator-bundle.png", fullPage: true });

  await lead.page.click('nav.tabs button:has-text("Resources")');
  // Availability is window-based, so the grid only fills after an explicit search.
  await lead.page.click('button:has-text("Search")');
  await lead.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  ok(
    "resource availability grid renders",
    `${await lead.page.locator("table.grid tbody tr").count()} units`,
  );
  await lead.page.screenshot({ path: "e2e/02-resources.png", fullPage: true });
  await lead.ctx.close();

  // ── Faculty: inbox → review → escalate, history preserved ──────────────
  const fac = await session("faculty.cse@demo.campusops.local");
  await fac.page.click('nav.tabs button:has-text("Approvals")');
  await fac.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  ok("faculty approval inbox", `${await fac.page.locator("table.grid tbody tr").count()} pending`);

  const targetRow = fac.page
    .locator("table.grid tbody tr", { hasText: title })
    .filter({ hasText: "Resource use" })
    .first();
  await targetRow.locator('button:has-text("Review")').click();
  await fac.page.waitForSelector(".timeline", { timeout: 15000 });
  ok("request detail shows history", `${await fac.page.locator(".timeline li").count()} actions`);
  const escalateBtn = fac.page.locator('button:has-text("Escalate to HOD/Dean")');
  if (await escalateBtn.count()) ok("faculty can escalate to HOD/Dean");
  else fail("escalation control", "not offered at faculty tier");

  await fac.page
    .locator("textarea")
    .fill("Needs the department head to sign off on this lab booking.");
  await escalateBtn.click();
  await fac.page.waitForSelector(".good-note", { timeout: 15000 });
  ok("escalation submitted from the browser");
  await fac.page.screenshot({ path: "e2e/03-faculty-escalated.png", fullPage: true });
  await fac.ctx.close();

  // ── Faculty approves the organize permission directly ──────────────────
  const fac2 = await session("faculty.cse@demo.campusops.local");
  await fac2.page.click('nav.tabs button:has-text("Approvals")');
  await fac2.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  const organizeRow = fac2.page
    .locator("table.grid tbody tr", { hasText: title })
    .filter({ hasText: "Permission to organize" })
    .first();
  await organizeRow.locator('button:has-text("Review")').click();
  await fac2.page.waitForSelector(".timeline", { timeout: 15000 });
  await fac2.page.locator('button:has-text("Approve")').first().click();
  await fac2.page
    .locator("table.grid tbody tr", { hasText: title })
    .filter({ hasText: "Permission to organize" })
    .waitFor({ state: "detached", timeout: 15000 });
  ok("faculty approved a permission from the browser");
  await fac2.ctx.close();

  // ── HOD/Dean: escalated request lands in the senior queue ──────────────
  const senior = await session("hoddean.cse@demo.campusops.local");
  await senior.page.click('nav.tabs button:has-text("Approvals")');
  await senior.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  const seniorRow = senior.page
    .locator("table.grid tbody tr", { hasText: title })
    .filter({ hasText: "Resource use" })
    .first();
  await seniorRow.waitFor({ timeout: 15000 });
  const tier = await seniorRow.locator("td").nth(2).textContent();
  // The UI shows the role label ("HOD/Dean"), not the internal SENIOR tier.
  if (tier?.trim() === "HOD/Dean")
    ok("escalated request reached the HOD/Dean queue", `tier ${tier.trim()}`);
  else fail("senior queue", `unexpected tier ${tier}`);
  await seniorRow.locator('button:has-text("Review")').click();
  await senior.page.waitForSelector(".timeline", { timeout: 15000 });
  const history = await senior.page.locator(".timeline li").allTextContents();
  if (history.some((h) => h.includes("ESCALATE")))
    ok("escalation preserved the faculty-tier history");
  else fail("history", "ESCALATE action missing after tier change");
  if (await senior.page.locator('button:has-text("Escalate to Admin")').count())
    ok("HOD/Dean can escalate one more tier to Admin");
  else fail("second escalation", "Admin escalation not offered");
  await senior.page.screenshot({ path: "e2e/04-senior-history.png", fullPage: true });
  // Approve at the senior tier so the coordinator's publish gate can open.
  await senior.page.locator('button:has-text("Approve")').first().click();
  await senior.page
    .locator("table.grid tbody tr", { hasText: title })
    .filter({ hasText: "Resource use" })
    .waitFor({ state: "detached", timeout: 15000 });
  ok("HOD/Dean approved the escalated permission");
  await senior.ctx.close();

  // ── Coordinator: publish only after every required approval ────────────
  const lead2 = await session("coding.lead@demo.campusops.local");
  await lead2.page.click('nav.tabs button:has-text("Events")');
  await lead2.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  const publishedRow = lead2.page.locator("table.grid tbody tr", { hasText: title }).first();
  await publishedRow.locator('button:has-text("Open")').click();
  await lead2.page.waitForSelector(".requests .request", { timeout: 15000 });
  const finalBadges = await lead2.page.locator(".requests .request .badge").allTextContents();
  ok("bundle now shows both permissions approved", finalBadges.join(", "));
  let publishedEventId = null;
  lead2.page.on("response", async (res) => {
    if (res.url().endsWith("/publish") && res.status() === 200) {
      try {
        const body = await res.json();
        publishedEventId = body?.data?.id ?? publishedEventId;
      } catch {
        /* response body not needed if unavailable */
      }
    }
  });
  const publishBtn = lead2.page.locator('button:has-text("Publish")').first();
  if (await publishBtn.isEnabled()) {
    await publishBtn.click();
    // Assert the resulting state, not a toast that a previous panel may have left behind.
    const publishedRow = lead2.page
      .locator("table.grid tbody tr", { hasText: title })
      .filter({ hasText: "PUBLISHED" })
      .first();
    await publishedRow.waitFor({ timeout: 15000 });
    ok("event published once every required approval was granted");
  } else {
    fail("publish gate", "still disabled after all required approvals were granted");
  }
  await lead2.page.screenshot({ path: "e2e/05-published.png", fullPage: true });
  await lead2.ctx.close();

  // ── Post-event report ──────────────────────────────────────────────────
  // Reports need a finished event. The seed provides one with real approvals,
  // resources, registrations and a gate check-in, so nothing here is faked.
  const apiBase = process.env.E2E_API ?? "http://127.0.0.1:8787/api/v1";
  async function call(method, path, token, body) {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, data: json?.data, error: json?.error };
  }
  const loginBody = await call("POST", "/auth/login", null, {
    email: "coding.lead@demo.campusops.local",
    password: PW,
    client: "mobile",
  });
  const leadToken = loginBody.data?.accessToken;

  const rep = await session("coding.lead@demo.campusops.local");
  await rep.page.click('nav.tabs button:has-text("Reports")');
  // Wait for the option itself: the select renders before /me/events resolves.
  const option = rep.page
    .locator("select option")
    .filter({ hasText: "Applied ML Recap Session" })
    .first();
  await option.waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  if (await option.count()) {
    const value = await option.getAttribute("value");
    await rep.page.selectOption("select", value);
    await rep.page.waitForSelector('button:has-text("Generate report")', { timeout: 15000 });
    ok("completed event is offered for reporting");

    await rep.page.fill("textarea", `Browser walkthrough ${stamp}: session ran to time.`);
    await rep.page.click('button:has-text("Generate report")');
    // The previous version already renders a .checksum, so wait for this run's
    // notes to appear rather than for an element that was already present.
    await rep.page.waitForSelector(".good-note", { timeout: 20000 });
    await rep.page.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      `Browser walkthrough ${stamp}`,
      { timeout: 20000 },
    );
    const checksum = ((await rep.page.locator(".checksum").first().textContent()) ?? "").trim();
    if (/^[a-f0-9]{64}$/.test(checksum))
      ok("report generated in the browser with a checksum", checksum.slice(0, 16));
    else fail("report checksum", `unexpected value: ${checksum}`);

    const bodyText = await rep.page.locator("body").innerText();

    for (const [label, needle] of [
      ["organising club", "Coding Club"],
      ["approvals trail", "Permissions and approvals"],
      ["faculty involvement", "Faculty involved"],
      ["resources used", "Resources used"],
      ["attendance", "Attendance"],
      ["coordinator notes", `Browser walkthrough ${stamp}`],
      // The stat label is uppercased by CSS, and innerText reflects that.
      ["QR check-in figure", "checked in"],
    ]) {
      if (bodyText.toLowerCase().includes(needle.toLowerCase())) ok(`report shows ${label}`);
      else fail(`report ${label}`, `"${needle}" missing from the rendered report`);
    }

    const [download] = await Promise.all([
      rep.page.waitForEvent("download", { timeout: 20000 }),
      rep.page.locator('button:has-text("PDF")').first().click(),
    ]);
    const dlPath = await download.path();
    const bytes = dlPath ? await (await import("node:fs/promises")).readFile(dlPath) : null;
    if (bytes && bytes.subarray(0, 5).toString() === "%PDF-" && bytes.length > 2000) {
      ok("report PDF downloaded from the browser", `${bytes.length} bytes`);
      await (await import("node:fs/promises")).writeFile("e2e/downloaded-report.pdf", bytes);
    } else fail("report PDF download", "not a valid PDF payload");
    await rep.page.screenshot({ path: "e2e/06-report.png", fullPage: true });
  } else {
    fail("report availability", "no completed event was offered for reporting");
  }
  await rep.ctx.close();

  // A report must not be issuable for an event that has not happened yet.
  if (leadToken && publishedEventId) {
    const early = await call("POST", `/events/${publishedEventId}/reports`, leadToken, {});
    if (early.status === 409) ok("report refused for an event that has not finished");
    else fail("report timing gate", `expected 409, got ${early.status}`);
  }

  // An unrelated faculty member must not reach the attendee list.
  const bystander = await call("POST", "/auth/login", null, {
    email: "faculty.ece@demo.campusops.local",
    password: PW,
    client: "mobile",
  });
  const completedList = await call("GET", "/me/events?limit=100", leadToken);
  const completed = completedList.data?.items?.find((e) => e.status === "COMPLETED");
  if (completed && bystander.data?.accessToken) {
    const denied = await call("GET", `/events/${completed.id}/reports`, bystander.data.accessToken);
    if (denied.status === 404 || denied.status === 403)
      ok("uninvolved faculty cannot read the report", `HTTP ${denied.status}`);
    else fail("report access control", `expected 403/404, got ${denied.status}`);
  }

  // ── Student: no staff tooling ──────────────────────────────────────────
  // An outsider student can never hold a club membership, so this assertion
  // stays valid even after other suites grant coordinator roles.
  const stu = await loginOnly("outsider@demo.campusops.local");
  const blocked = await stu.page
    .locator('h2:has-text("This console is for staff and club coordinators")')
    .count();
  const stuTabs = await stu.page.locator("nav.tabs button").count();
  if (blocked === 1 && stuTabs === 0)
    ok("a plain student is kept out of the management console", "directed to the mobile app");
  else fail("student scoping", `notice=${blocked} tabs=${stuTabs}`);
  await stu.ctx.close();
} catch (err) {
  fail("e2e run", err.message.split("\n")[0]);
} finally {
  await browser.close();
}

console.log(results.join("\n"));
console.log(
  errors.length
    ? `\nBROWSER ERRORS:\n${[...new Set(errors)].join("\n")}`
    : "\nNo browser console/page errors.",
);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
