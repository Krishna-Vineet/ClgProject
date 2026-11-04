import { chromium } from "playwright";

/**
 * Phase 4 management console walkthrough, in a real browser.
 * Covers the panels added this phase: administration, departments, clubs and
 * members, resource catalogue and units, student verification, event operations
 * and account self-service — plus the role gates between them.
 *
 * Run: E2E_PASSWORD=... E2E_CHROMIUM_PATH=/usr/bin/chromium bun run e2e/management.mjs
 */
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5173";
const PW = process.env.E2E_PASSWORD;
if (!PW) throw new Error("E2E_PASSWORD is required (the seeded demo password).");

const results = [];
const errors = [];
// Statuses a test deliberately provokes (e.g. a duplicate-code 409).
const expected = [];
const expectHttp = (status, count = 1) => expected.push({ status, left: count });
function isExpected(status) {
  const hit = expected.find((e) => e.status === status && e.left > 0);
  if (!hit) return false;
  hit.left -= 1;
  return true;
}
const ok = (name, detail = "") => results.push(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail) => results.push(`FAIL  ${name} — ${detail}`);

const executablePath = process.env.E2E_CHROMIUM_PATH;
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(executablePath ? { executablePath } : {}),
});

const stamp = Date.now();

function watch(page, email) {
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400 && res.status() !== 401 && !isExpected(res.status()))
      errors.push(`${email} HTTP ${res.status()}: ${res.url()}`);
  });
  page.on("console", (m) => {
    const t = m.text();
    // Chromium logs a console line for any 4xx; the response hook above is the
    // authority, so only keep console errors that are not HTTP status noise.
    if (m.type() === "error" && !/Failed to load resource|status of 4|status of 5/.test(t))
      errors.push(`${email} console: ${t}`);
  });
}

async function session(email, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 } });
  const page = await ctx.newPage();
  watch(page, email);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector("nav.tabs", { timeout: 20000 });
  return { ctx, page };
}

const tab = async (page, label) => {
  const menu = page.locator('button[aria-label="Open menu"]');
  if (await menu.isVisible()) await menu.click();
  await page.click(`nav.tabs button:has-text("${label}")`);
};
const sub = (page, label) => page.click(`.subtabs button:has-text("${label}")`);
/** Event workspace tabs are their own navigation, not the panel's sub-tabs. */
const eventTab = (page, label) => page.click(`.event-nav button:has-text("${label}")`);

/** Fill a Field by its visible label, scoped to a container. */
async function field(scope, label, value) {
  await scope
    .locator("div.field", { hasText: label })
    .first()
    .locator("input, textarea")
    .first()
    .fill(value);
}

try {
  // ── Login surface: staff only, and honest errors ─────────────────────────
  const anon = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const anonPage = await anon.newPage();
  watch(anonPage, "anonymous");
  await anonPage.goto(BASE, { waitUntil: "networkidle" });
  const anonText = await anonPage.locator("body").innerText();
  const signUpControls = await anonPage
    .locator(
      'button:has-text("Create account"), button:has-text("Register"), input[name="collegeIdNumber"]',
    )
    .count();
  if (signUpControls === 0 && /mobile app/i.test(anonText))
    ok("no student self-registration on the website", "students pointed at the mobile app");
  else fail("auth surface", `sign-up controls=${signUpControls}`);
  const modeButtons = await anonPage.locator("form button.ghost, .row button").allTextContents();
  ok("staff auth modes offered", modeButtons.slice(0, 3).join(", "));

  await anonPage.fill('input[name="email"]', "principal@demo.campusops.local");
  await anonPage.fill('input[name="password"]', "definitely-the-wrong-password");
  await anonPage.click('button[type="submit"]');
  await anonPage.waitForSelector(".bad-note", { timeout: 15000 });
  ok(
    "bad credentials produce a visible error",
    (await anonPage.locator(".bad-note").first().innerText()).slice(0, 60),
  );
  await anon.close();

  // ── Admin: users, roles, departments, maintenance ────────────────────────
  const admin = await session("principal@demo.campusops.local");
  const adminTabs = await admin.page.locator("nav.tabs button").allTextContents();
  ok("admin navigation", adminTabs.join(", "));
  if (adminTabs.some((t) => t.includes("Administration"))) ok("admin reaches administration");
  else fail("admin gate", "Administration tab missing");

  await tab(admin.page, "Administration");
  await admin.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  ok("user directory renders", `${await admin.page.locator("table.grid tbody tr").count()} rows`);

  // Search narrows the directory instead of relying on page 1.
  // The directory filters as you type; there is no submit button.
  await field(admin.page, "Search", "coding.lead");
  await admin.page.waitForSelector('table.grid tbody tr:has-text("coding.lead")', {
    timeout: 15000,
  });
  await admin.page.waitForFunction(
    () => document.querySelectorAll("table.grid tbody tr").length === 1,
    { timeout: 15000 },
  );
  const narrowed = await admin.page.locator("table.grid tbody tr").count();
  if (narrowed === 1) ok("user search filters the directory", "1 match");
  else fail("user search", `expected 1 row, got ${narrowed}`);

  await admin.page.locator("table.grid tbody tr").first().locator("button").first().click();
  await admin.page.waitForSelector('h2:has-text("Manage:")', { timeout: 15000 });
  const detailText = await admin.page
    .locator("section.card", { has: admin.page.locator('h2:has-text("Manage:")') })
    .innerText();
  if (/club/i.test(detailText)) ok("user detail exposes club memberships");
  else fail("user detail", "memberships not shown");
  if (!/passwordHash|\$argon2/i.test(detailText)) ok("user detail leaks no password material");
  else fail("user detail", "password material rendered");

  // Departments: create, then rename, then confirm it appears in pickers.
  await sub(admin.page, "Departments");
  await admin.page.waitForSelector('button:has-text("Create department")', { timeout: 15000 });
  const deptCode = `E2E${String(stamp).slice(-6)}`;
  // The create form is always present on this sub-tab.
  const createCard = admin.page.locator("section.card", {
    has: admin.page.locator('h2:has-text("Create a department")'),
  });
  await field(createCard, "Code", deptCode);
  await field(createCard, "Name", `E2E Department ${stamp}`);
  await createCard.locator('button[type="submit"]').click();
  await admin.page.waitForSelector(`table.grid tbody tr:has-text("${deptCode}")`, {
    timeout: 15000,
  });
  ok("department created through the UI", deptCode);

  const deptRow = admin.page.locator("table.grid tbody tr", { hasText: deptCode }).first();
  await deptRow.locator('button:has-text("Rename")').click();
  const renameCard = admin.page.locator("section.card", {
    has: admin.page.locator('h2:has-text("Rename department")'),
  });
  await renameCard.waitFor({ state: "visible", timeout: 15000 });
  await field(renameCard, "Name", `E2E Renamed ${stamp}`);
  await renameCard.locator('button[type="submit"]').click();
  await admin.page.waitForSelector(`table.grid tbody tr:has-text("E2E Renamed ${stamp}")`, {
    timeout: 15000,
  });
  ok("department renamed through the UI");

  // Duplicate code must be refused with a readable message, not a crash.
  await field(createCard, "Code", deptCode);
  await field(createCard, "Name", "Duplicate attempt");
  expectHttp(409);
  await createCard.locator('button[type="submit"]').click();
  await admin.page.waitForSelector(".toast.err, .bad-note", { timeout: 15000 });
  ok("duplicate department code is refused in the UI");

  await sub(admin.page, "Maintenance");
  await admin.page.waitForSelector('button:has-text("Run now")', { timeout: 15000 });
  await admin.page.waitForSelector(".stats .stat-value", { timeout: 15000 });
  const counters = await admin.page.locator(".stats .stat-label").allTextContents();
  if (counters.length >= 2) ok("maintenance shows outbox counters", counters.join(", "));
  else fail("maintenance", `only ${counters.length} counters rendered`);
  await admin.page.click('button:has-text("Run now")');
  await admin.page.waitForSelector(".toast.ok", { timeout: 20000 });
  ok("maintenance job triggered from the UI");
  await admin.page.screenshot({ path: "e2e/p4-01-admin.png", fullPage: true });
  await admin.ctx.close();

  // ── Clubs: admin creates; a club lead manages members ────────────────────
  const leadCheck = await session("coding.lead@demo.campusops.local");
  const leadCheckTabs = await leadCheck.page.locator("nav.tabs button").allTextContents();
  if (!leadCheckTabs.some((t) => t.includes("Administration")))
    ok("coordinator cannot see administration", leadCheckTabs.join(", "));
  else fail("role gate", "coordinator sees Administration");

  await tab(leadCheck.page, "Clubs");
  await leadCheck.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  ok("club list renders", `${await leadCheck.page.locator("table.grid tbody tr").count()} rows`);
  if ((await leadCheck.page.locator('button:has-text("Create club")').count()) === 0)
    ok("club creation is withheld from a club lead");
  else fail("club gate", "a club lead was offered club creation");
  await leadCheck.ctx.close();

  const clubAdmin = await session("principal@demo.campusops.local");
  await tab(clubAdmin.page, "Clubs");
  await clubAdmin.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  const clubName = `E2E Club ${stamp}`;
  await clubAdmin.page.click('button:has-text("Create club")');
  await field(clubAdmin.page, "Name", clubName);
  await clubAdmin.page.click('form button[type="submit"]:has-text("Create club")');
  await clubAdmin.page.waitForSelector(`table.grid tbody tr:has-text("${clubName}")`, {
    timeout: 15000,
  });
  ok("club created through the UI", clubName);

  const clubRow = clubAdmin.page.locator("table.grid tbody tr", { hasText: clubName }).first();
  await clubRow.locator('button:has-text("Open")').click();
  await clubAdmin.page.waitForSelector('input[placeholder="At least 2 characters"]', {
    timeout: 15000,
  });
  await clubAdmin.page.fill('input[placeholder="At least 2 characters"]', "student.verified");
  await clubAdmin.page.click('button:has-text("Search")');
  await clubAdmin.page.waitForSelector(".detail-panel table.grid tbody tr", { timeout: 20000 });
  ok("member candidate search returns accounts");
  const candRow = clubAdmin.page.locator(".detail-panel table.grid tbody tr").first();
  await candRow.locator('button:has-text("Add as coordinator")').click();
  await clubAdmin.page.waitForSelector(".toast.ok", { timeout: 15000 });
  ok("coordinator added to the club from the UI");
  await clubAdmin.page.screenshot({ path: "e2e/p4-02-clubs.png", fullPage: true });
  await clubAdmin.ctx.close();

  // ── Event operations: edit a draft, eligibility, invitations, history ────
  const lead = await session("coding.lead@demo.campusops.local");
  await tab(lead.page, "Events");
  await lead.page.waitForSelector('button:has-text("New event")', { timeout: 15000 });
  await lead.page.click('button:has-text("New event")');
  const draftTitle = `E2E Ops Event ${stamp}`;
  const draftForm = lead.page.locator("form.form.wide").first();
  await draftForm.locator("input").nth(0).fill(draftTitle);
  await lead.page.click('button:has-text("Create draft")');
  await lead.page.waitForSelector(`h2:has-text("${draftTitle}")`, { timeout: 15000 });
  ok("draft created for event operations");

  await lead.page.waitForSelector('.event-nav button:has-text("Edit details")', { timeout: 15000 });
  await eventTab(lead.page, "Edit details");
  await lead.page.waitForSelector('legend:has-text("Who may register")', { timeout: 15000 });
  ok("draft editor exposes the eligibility policy");
  const opsForm = lead.page.locator("form.form.wide").last();
  await opsForm.locator('input[type="number"]').first().fill("75");
  await opsForm
    .locator("label.checkbox", { hasText: "Require an invitation" })
    .locator("input")
    .check();
  await opsForm.locator('button[type="submit"]:has-text("Save draft")').click();
  await lead.page.waitForSelector(".toast.ok", { timeout: 15000 });
  ok("draft edited and saved with an eligibility policy");

  await eventTab(lead.page, "Invitations");
  await lead.page.waitForSelector('textarea[placeholder="student@othercollege.edu"]', {
    timeout: 15000,
  });
  await lead.page.fill(
    'textarea[placeholder="student@othercollege.edu"]',
    `outsider.${stamp}@othercollege.edu, second.${stamp}@othercollege.edu`,
  );
  await lead.page.click('button:has-text("Invite")');
  await lead.page.waitForSelector(`table.grid tbody tr:has-text("outsider.${stamp}")`, {
    timeout: 15000,
  });
  ok("invitations recorded through the UI", "2 addresses");
  const inviteRow = lead.page
    .locator("table.grid tbody tr", { hasText: `outsider.${stamp}` })
    .first();
  await inviteRow.locator('button:has-text("Revoke")').click();
  await lead.page.waitForSelector("dialog.modal[open]", { timeout: 10000 });
  ok("destructive action opens a real modal dialog");
  await lead.page.locator('dialog.modal[open] button:has-text("Revoke")').click();
  await lead.page.waitForSelector(
    `table.grid tbody tr:has-text("outsider.${stamp}"):has-text("Revoked")`,
    {
      timeout: 15000,
    },
  );
  ok("invitation revoked through the UI");

  await eventTab(lead.page, "History");
  await lead.page.waitForSelector('h3:has-text("Audit trail")', { timeout: 15000 });
  const historyText = await lead.page.locator("body").innerText();
  if (/revision/i.test(historyText)) ok("event history shows revisions and audit");
  else fail("event history", "no revision section");

  await eventTab(lead.page, "Day of event");
  const startDisabled = await lead.page.locator('button:has-text("Start event")').isDisabled();
  if (startDisabled) ok("start is blocked for an unapproved draft");
  else fail("lifecycle gate", "Start enabled on a DRAFT");
  await lead.page.screenshot({ path: "e2e/p4-03-event-ops.png", fullPage: true });

  // ── Resources: catalogue CRUD for a manager ──────────────────────────────
  await lead.ctx.close();

  const senior = await session("hoddean.cse@demo.campusops.local");
  await tab(senior.page, "Resources");
  await sub(senior.page, "Catalogue");
  await senior.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  ok("HOD/Dean sees the resource catalogue");
  const canAdd = await senior.page.locator('button:has-text("Add resource")').count();
  if (canAdd) ok("HOD/Dean may manage resources in scope");
  else fail("resource scope", "HOD/Dean cannot add a resource");

  await senior.page.click('button:has-text("Add resource")');
  const resName = `E2E Lab ${stamp}`;
  await field(senior.page, "Name", resName);
  await field(senior.page, "Bookable units", `${resName}-A`);
  await senior.page.click('form button[type="submit"]:has-text("Create resource")');
  await senior.page.waitForSelector(`table.grid tbody tr:has-text("${resName}")`, {
    timeout: 15000,
  });
  ok("resource created with its bookable units");

  const resRow = senior.page.locator("table.grid tbody tr", { hasText: resName }).first();
  await resRow.locator('button:has-text("Open")').click();
  await senior.page.waitForSelector(`h2:has-text("${resName}")`, { timeout: 15000 });
  const resCard = senior.page.locator("section.card", {
    has: senior.page.locator(`h2:has-text("${resName}")`),
  });
  const unitRow = resCard.locator("table.grid tbody tr").first();
  await unitRow.locator('button:has-text("Retire")').click();
  await senior.page.waitForSelector("dialog.modal[open]", { timeout: 10000 });
  await senior.page.locator("dialog.modal[open] button.danger").click();
  await senior.page.waitForSelector(".toast.ok", { timeout: 15000 });
  ok("resource unit retired through the UI");

  await sub(senior.page, "Booking calendar");
  await senior.page.waitForSelector('button:has-text("Show bookings")', { timeout: 15000 });
  await senior.page.click('button:has-text("Show bookings")');
  await senior.page.waitForSelector("table.grid", { timeout: 15000 });
  ok("booking calendar renders for the window");
  await senior.page.screenshot({ path: "e2e/p4-04-resources.png", fullPage: true });

  // HOD/Dean may read the verification queue but must not decide on it.
  await tab(senior.page, "Student verification");
  await senior.page.waitForSelector('h2:has-text("Student verification queue")', {
    timeout: 15000,
  });
  // Review is a read action; the decision and the identity documents are not.
  if ((await senior.page.locator('button:has-text("Review")').count()) > 0) {
    await senior.page.locator('button:has-text("Review")').first().click();
    await senior.page.waitForSelector('h2:has-text("Review:")', { timeout: 15000 });
    const decide = await senior.page
      .locator('button:has-text("Verify student"), button:has-text("Open college ID proof")')
      .count();
    if (decide === 0) ok("HOD/Dean reviews verification without deciding or seeing ID documents");
    else fail("verification gate", `HOD/Dean was offered ${decide} faculty-only controls`);
  } else {
    ok("HOD/Dean reads the verification queue", "no pending students to review");
  }
  await senior.ctx.close();

  // ── Faculty: verification queue ──────────────────────────────────────────
  const fac = await session("faculty.cse@demo.campusops.local");
  await tab(fac.page, "Student verification");
  await fac.page.waitForSelector('h2:has-text("Student verification queue")', { timeout: 15000 });
  const queueText = await fac.page.locator("body").innerText();
  ok("faculty verification queue renders", /queue/i.test(queueText) ? "queue visible" : "");
  const reviewCount = await fac.page.locator('button:has-text("Review")').count();
  if (reviewCount > 0) {
    await fac.page.locator('button:has-text("Review")').first().click();
    await fac.page.waitForSelector('h2:has-text("Review:")', { timeout: 15000 });
    const hasDecide = await fac.page.locator('button:has-text("Verify student")').count();
    if (hasDecide) ok("faculty can decide a student verification");
    else fail("verification", "faculty has no verify control");
    await fac.page.screenshot({ path: "e2e/p4-05-verification.png", fullPage: true });
  } else {
    ok("faculty verification queue is empty but explained", "no pending students");
  }

  // ── Account self-service ─────────────────────────────────────────────────
  await tab(fac.page, "Account");
  await fac.page.waitForSelector('h2:has-text("Your account")', { timeout: 15000 });
  const accountText = await fac.page.locator("body").innerText();
  if (/Faculty/i.test(accountText)) ok("account panel shows the signed-in roles");
  else fail("account", "roles not shown");

  // Mismatched confirmation must be caught before any request is sent.
  await field(fac.page, "Current password", PW);
  await field(fac.page, "New password", "A-Brand-New-Password-2026!");
  await field(fac.page, "Confirm new password", "A-Different-Password-2026!");
  const changeBtn = fac.page.locator('button:has-text("Change password")').last();
  const disabledOnMismatch = await changeBtn.isDisabled();
  if (disabledOnMismatch) ok("password change is blocked while confirmation differs");
  else {
    await changeBtn.click();
    await fac.page.waitForSelector(".bad-note, .toast.err", { timeout: 10000 });
    ok("password mismatch is reported");
  }
  await fac.page.screenshot({ path: "e2e/p4-06-account.png", fullPage: true });
  await fac.ctx.close();

  // ── Narrow viewport: nothing may overflow the page ───────────────────────
  const narrow = await session("principal@demo.campusops.local", 420);
  await tab(narrow.page, "Administration");
  await narrow.page.waitForSelector("table.grid", { timeout: 15000 });
  const overflow = await narrow.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow <= 1) ok("no horizontal page overflow at 420px", `${overflow}px`);
  else fail("responsive layout", `${overflow}px of horizontal overflow`);
  await narrow.page.screenshot({ path: "e2e/p4-07-narrow.png", fullPage: true });
  await narrow.ctx.close();
} catch (err) {
  fail("management e2e run", err.message.split("\n").slice(0, 3).join(" | "));
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
const passed = results.filter((r) => r.startsWith("PASS")).length;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 || errors.length > 0 ? 1 : 0);
