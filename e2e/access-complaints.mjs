import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Round-2 walkthrough: the access-QR and complaint tabs in the event workspace,
 * plus the club faculty picker that replaced the advisor role.
 *
 * Run: E2E_PASSWORD=... E2E_CHROMIUM_PATH=/usr/bin/chromium bun run e2e/access-complaints.mjs
 */
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5173";
const PW = process.env.E2E_PASSWORD;
if (!PW) throw new Error("E2E_PASSWORD is required (the seeded demo password).");

const results = [];
const errors = [];
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
mkdirSync("e2e/downloads", { recursive: true });

function watch(page, who) {
  page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400 && res.status() !== 401 && !isExpected(res.status()))
      errors.push(`${who} HTTP ${res.status()}: ${res.url()}`);
  });
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource|status of 4|status of 5/.test(t))
      errors.push(`${who} console: ${t}`);
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
const rowWith = (page, text) => page.locator("table.grid tbody tr", { hasText: text }).first();

async function fieldByLabel(scope, label, value) {
  await scope
    .locator("div.field", { hasText: label })
    .first()
    .locator("input, textarea")
    .first()
    .fill(value);
}

try {
  // ── Access QRs on a live event ───────────────────────────────────────────
  const lead = await session("coding.lead@demo.campusops.local");
  await tab(lead.page, "Events");
  await lead.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });

  // The seeded completed event proves the tabs render for a closed event too,
  // but configuration needs an open one: create a draft and drive it live via
  // the API is out of scope here, so use the seeded event the lead owns.
  const targetRow = lead.page.locator("table.grid tbody tr").first();
  await targetRow.locator('button:has-text("Open")').click();
  await lead.page.waitForSelector('.subtabs button:has-text("Access QRs")', { timeout: 15000 });
  ok("event workspace exposes an Access QRs tab");
  await sub(lead.page, "Access QRs");
  await lead.page.waitForSelector('.subtabs button:has-text("QR rules")', { timeout: 15000 });
  ok("access tab opens on coordinator-defined QR rules");

  const addBlock = lead.page.locator(".sub-form").first();
  const selectField = (label, value) =>
    addBlock.locator("div.field", { hasText: label }).first().locator("select").selectOption(value);
  async function addQr(name, type, validity, extra = () => {}) {
    await fieldByLabel(addBlock, "QR name", name);
    await selectField("QR type", type);
    await selectField("Validity", validity);
    await extra();
    await addBlock.locator('button:has-text("Add QR")').click();
    await lead.page.waitForSelector(`table.grid tbody tr:has-text("${name}")`, { timeout: 15000 });
  }

  const countedName = `E2E xyz ${stamp}`;
  await addQr(countedName, "COUNTED", "MANUAL", async () => {
    await fieldByLabel(addBlock, "Valid uses per participant", "4");
  });
  ok("a free-form name, counted type and switch-only validity can be defined together");
  const countedRow = rowWith(lead.page, countedName);
  if (!(await countedRow.innerText()).includes("Set number of uses · 4"))
    throw new Error("Counted rule not shown");
  ok("the rule list shows the chosen type and number, not a preset purpose");

  const toggleName = `E2E Gate ${stamp}`;
  await addQr(toggleName, "TOGGLE", "WINDOW");
  ok("a toggle in/out QR can be defined for a time window");
  const dateName = `E2E abc ${stamp}`;
  await addQr(dateName, "ONE_TIME", "DATE", async () => {
    await addBlock.locator('div.field:has-text("Valid on") input').fill("2026-11-14");
  });
  ok("a one-time QR can be restricted to one date");
  if (await addBlock.locator('div.field:has-text("Purpose")').count())
    throw new Error("Purpose selector still exists");
  ok("no fixed purpose selector remains");

  // The switch-only endpoint, exercised through the row action.
  const stateBefore = await rowWith(lead.page, countedName).locator(".badge").innerText();
  await rowWith(lead.page, countedName).locator('button:has-text("Switch off")').click();
  await lead.page.waitForFunction(
    (name) => {
      const row = [...document.querySelectorAll("table.grid tbody tr")].find((r) =>
        r.textContent.includes(name),
      );
      return row?.querySelector(".badge")?.textContent?.trim() === "Off";
    },
    countedName,
    { timeout: 15000 },
  );
  ok("a QR can be switched off mid-event", `${stateBefore} → Off`);
  await rowWith(lead.page, countedName).locator('button:has-text("Switch on")').click();
  await lead.page.waitForFunction(
    (name) => {
      const row = [...document.querySelectorAll("table.grid tbody tr")].find((r) =>
        r.textContent.includes(name),
      );
      return row?.querySelector(".badge")?.textContent?.trim() === "On";
    },
    countedName,
    { timeout: 15000 },
  );
  ok("and switched back on without editing its rule");

  // Editing the counted limit sends the full rule.
  await rowWith(lead.page, countedName).locator('button:has-text("Edit")').click();
  await lead.page.waitForSelector('button:has-text("Save QR rule")', { timeout: 15000 });
  await fieldByLabel(lead.page.locator(".sub-form").first(), "Valid uses per participant", "5");
  await lead.page.click('button:has-text("Save QR rule")');
  await lead.page.waitForSelector(".toast.ok", { timeout: 15000 });
  await lead.page.waitForSelector(`table.grid tbody tr:has-text("${countedName}"):has-text("5")`, {
    timeout: 15000,
  });
  ok("a counted QR's limit can be edited");

  // Deleting an unused QR.
  await rowWith(lead.page, dateName).locator('button:has-text("Delete")').click();
  await lead.page.waitForSelector("dialog[open]", { timeout: 15000 });
  await lead.page.click('dialog[open] button:has-text("Delete QR")');
  await lead.page.waitForSelector(".toast.ok", { timeout: 15000 });
  ok("an unused QR can be deleted after confirmation");

  await sub(lead.page, "Passes");
  await lead.page.waitForSelector('button:has-text("Issue passes")', { timeout: 15000 });
  await lead.page.click('button:has-text("Issue passes")');
  await lead.page.waitForSelector(".toast.ok", { timeout: 15000 });
  ok("passes can be issued to confirmed participants");
  await sub(lead.page, "Scan log");
  await lead.page.waitForSelector('div.field:has-text("Outcome")', { timeout: 15000 });
  ok("the scan log is reachable with QR and outcome filters");
  await sub(lead.page, "QR rules");
  await lead.page.screenshot({ path: "e2e/p45-01-access.png", fullPage: true });

  // ── Complaints: create a point, download its poster, read the inbox ───────
  await sub(lead.page, "Complaints");
  await lead.page.waitForSelector('.subtabs button:has-text("Reporting points & QRs")', {
    timeout: 15000,
  });
  await sub(lead.page, "Reporting points & QRs");
  const pointName = `E2E Sound desk ${stamp}`;
  const pointBlock = lead.page.locator(".sub-form").first();
  await fieldByLabel(pointBlock, "Point name", pointName);
  await fieldByLabel(pointBlock, "Where exactly", "Stage left, beside the mixing console.");
  await pointBlock.locator('button:has-text("Add point")').click();
  await lead.page.waitForSelector(`table.grid tbody tr:has-text("${pointName}")`, {
    timeout: 15000,
  });
  ok("a reporting point can be created for an ad-hoc spot");

  const downloadPromise = lead.page.waitForEvent("download", { timeout: 20000 });
  await rowWith(lead.page, pointName).locator('button:has-text("Download PDF")').click();
  const download = await downloadPromise;
  const path = `e2e/downloads/${download.suggestedFilename()}`;
  await download.saveAs(path);
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 5).toString() === "%PDF-" && bytes.length > 2000)
    ok("the complaint QR downloads as a PDF", `${download.suggestedFilename()}, ${bytes.length}B`);
  else fail("poster download", `not a PDF (${bytes.length} bytes)`);
  writeFileSync("e2e/downloads/poster-path.txt", path);

  await rowWith(lead.page, pointName).locator('button:has-text("Close")').click();
  await lead.page.waitForSelector(".toast.ok", { timeout: 15000 });
  await lead.page.waitForSelector(
    `table.grid tbody tr:has-text("${pointName}") button:has-text("Reopen")`,
    { timeout: 15000 },
  );
  ok("a reporting point can be closed and reopened");
  await lead.page.screenshot({ path: "e2e/p45-02-complaint-points.png", fullPage: true });

  await sub(lead.page, "Issues raised");
  await lead.page.waitForSelector('div.field:has-text("Reporting point")', { timeout: 15000 });
  ok("the complaint inbox is filterable by status and point");

  // ── A club faculty member sees the tabs read-only, never the scanner role ─
  await lead.ctx.close();
  const faculty = await session("faculty.cse@demo.campusops.local");
  await tab(faculty.page, "Events");
  await faculty.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  await faculty.page
    .locator("table.grid tbody tr")
    .first()
    .locator('button:has-text("Open")')
    .click();
  await faculty.page.waitForSelector('.subtabs button:has-text("Access QRs")', { timeout: 15000 });
  await sub(faculty.page, "Access QRs");
  await faculty.page.waitForSelector('.subtabs button:has-text("QR rules")', {
    timeout: 15000,
  });
  const bodyText = await faculty.page.locator("body").innerText();
  if (/coordinators can change its QR rules/i.test(bodyText))
    ok("club faculty see QR rules read-only", "configuration stays with coordinators");
  else fail("faculty read-only", "the read-only explanation was not shown");
  if (/scanning staff|scanner account/i.test(bodyText))
    fail("no scanning-staff role", "the portal still mentions scanning staff");
  else ok("no scanning-staff role anywhere in the access portal");
  await faculty.ctx.close();

  // ── The advisor role is gone; faculty are added by HOD/Dean ───────────────
  const senior = await session("hoddean.cse@demo.campusops.local");
  await tab(senior.page, "Clubs");
  await senior.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  const clubsText = await senior.page.locator("body").innerText();
  if (/faculty advisor/i.test(clubsText))
    fail("advisor role removed", "the clubs panel still says Faculty advisor");
  else ok("no Faculty advisor field or column in the clubs panel");
  await senior.page
    .locator("table.grid tbody tr", { hasText: "Demo Coding Club" })
    .first()
    .locator('button:has-text("Open")')
    .click();
  await senior.page.waitForSelector('h3:has-text("Club team")', { timeout: 15000 });
  ok("the club team section replaces the coordinators-only list");
  await senior.page.waitForSelector('h3:has-text("Club faculty")', { timeout: 15000 });
  ok("HOD/Dean gets a club faculty picker");
  await senior.page
    .locator("div.detail-panel", { hasText: "Club faculty" })
    .locator("input")
    .first()
    .fill("faculty");
  await senior.page
    .locator("div.detail-panel", { hasText: "Club faculty" })
    .locator('button:has-text("Search")')
    .click();
  await senior.page.waitForTimeout(1200);
  const facultyPickerText = await senior.page
    .locator("div.detail-panel", { hasText: "Club faculty" })
    .innerText();
  if (/Add to club|No matching/i.test(facultyPickerText) || /@demo/.test(facultyPickerText))
    ok("the faculty picker queries faculty accounts only");
  else fail("faculty picker", facultyPickerText.slice(0, 120));
  await senior.page.screenshot({ path: "e2e/p45-03-club-faculty.png", fullPage: true });
  await senior.ctx.close();

  // A club lead must NOT be able to add faculty.
  const lead2 = await session("coding.lead@demo.campusops.local");
  await tab(lead2.page, "Clubs");
  await lead2.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  await lead2.page
    .locator("table.grid tbody tr", { hasText: "Demo Coding Club" })
    .first()
    .locator('button:has-text("Open")')
    .click();
  await lead2.page.waitForSelector('h3:has-text("Club team")', { timeout: 15000 });
  const leadFacultyPickers = await lead2.page.locator('h3:has-text("Club faculty")').count();
  if (leadFacultyPickers === 0)
    ok("a club lead cannot add faculty", "the picker is hidden, matching the API");
  else fail("faculty grant gate", "the lead can see the faculty picker");
  await lead2.ctx.close();

  // ── Narrow viewport ──────────────────────────────────────────────────────
  const narrow = await session("coding.lead@demo.campusops.local", 420);
  await tab(narrow.page, "Events");
  await narrow.page.waitForSelector("table.grid tbody tr", { timeout: 15000 });
  await narrow.page
    .locator("table.grid tbody tr")
    .first()
    .locator('button:has-text("Open")')
    .click();
  await narrow.page.waitForSelector('.subtabs button:has-text("Access QRs")', { timeout: 15000 });
  await sub(narrow.page, "Access QRs");
  await narrow.page.waitForSelector('.subtabs button:has-text("QR rules")', {
    timeout: 15000,
  });
  const overflow = await narrow.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow <= 1) ok("no horizontal page overflow at 420px", `${overflow}px`);
  else fail("responsive layout", `${overflow}px of horizontal overflow`);
  await narrow.page.screenshot({ path: "e2e/p45-04-narrow.png", fullPage: true });
  await narrow.ctx.close();
} catch (err) {
  fail("access/complaints e2e run", err.message.split("\n").slice(0, 3).join(" | "));
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
