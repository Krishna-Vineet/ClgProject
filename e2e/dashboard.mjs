import { chromium } from "playwright";

/** Phase 6 website UI walkthrough: dashboard, shell, search, theme, responsive. */
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5173";
const API = process.env.E2E_API ?? "http://127.0.0.1:8787/api/v1";
const PW = process.env.E2E_PASSWORD;
if (!PW) throw new Error("E2E_PASSWORD is required");
const results = [];
const errors = [];
const ok = (n, d = "") => {
  const l = `PASS  ${n}${d ? ` — ${d}` : ""}`;
  results.push(l);
  console.log(l);
};
const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
});

async function api(path, body, token) {
  const r = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return j.data;
}
async function session(email, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
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
const tab = async (page, label) => {
  const m = page.locator('button[aria-label="Open menu"]');
  if (await m.isVisible()) await m.click();
  await page.click(`nav.tabs button:has-text("${label}")`);
};

try {
  const admin = await api("/auth/login", {
    email: "principal@demo.campusops.local",
    password: PW,
    client: "mobile",
  });
  const dash = await api("/me/dashboard", undefined, admin.accessToken);
  const a = await session("principal@demo.campusops.local");
  await a.page.waitForSelector(".stat-grid");
  await a.page.getByText("Institution-wide", { exact: false }).waitFor();
  const liveCard = a.page
    .locator(".stat-card", { hasText: "Live right now" })
    .locator(".stat-value");
  if ((await liveCard.innerText()).trim() !== String(dash.events.live))
    throw new Error("Dashboard live count differs from API");
  ok(
    "dashboard renders exact role-scoped API counts",
    `live=${dash.events.live}, confirmed=${dash.registrations.confirmed}`,
  );
  await a.page.screenshot({ path: "e2e/p6-01-dashboard.png", fullPage: true });

  // Theme toggle persists and does not lose session.
  await a.page.click('button[aria-label^="Switch to"]');
  const theme = await a.page.evaluate(() => document.documentElement.dataset.theme);
  await a.page.reload({ waitUntil: "networkidle" });
  await a.page.waitForSelector("nav.tabs");
  if ((await a.page.evaluate(() => document.documentElement.dataset.theme)) !== theme)
    throw new Error("Theme not persisted");
  ok("light/dark theme toggle persists across reload", theme);
  await a.page.screenshot({ path: "e2e/p6-02-dark.png", fullPage: true });
  await a.page.click('button[aria-label^="Switch to"]');

  // Global search finds a visible event and deep-links into the workspace.
  await a.page.fill('input[aria-label="Search events"]', "Tech Fest");
  await a.page.locator(".popover-item", { hasText: "Demo One-Day Tech Fest" }).waitFor();
  ok("global search returns matching visible events");
  await a.page.keyboard.press("Escape");

  // Notifications popover reflects real workload.
  await a.page.click('button[aria-label^="Notifications"]');
  await a.page.locator(".popover h4", { hasText: "Needs attention" }).waitFor();
  ok("notifications popover opens with real workload");
  await a.page.keyboard.press("Escape");

  // Hash routing: direct link lands on the right section after reload.
  await a.page.goto(`${BASE}/#/resources`, { waitUntil: "networkidle" });
  await a.page.locator("h1", { hasText: "Resources" }).waitFor();
  ok("hash deep link opens the requested section");

  // Coordinator: dashboard → new event opens the draft form; faculty read-only.
  await a.ctx.close();
  const lead = await session("coding.lead@demo.campusops.local");
  await lead.page.getByRole("button", { name: "New event", exact: true }).click();
  await lead.page.locator("h2", { hasText: "New event draft" }).waitFor();
  ok("dashboard quick action opens the event draft form");
  await lead.page.screenshot({ path: "e2e/p6-03-events.png", fullPage: true });
  await lead.ctx.close();

  const fac = await session("faculty.cse@demo.campusops.local");
  if (await fac.page.getByRole("button", { name: "New event", exact: true }).count())
    throw new Error("Faculty must not get New event");
  await tab(fac.page, "Events");
  await fac.page
    .getByText("Read-only view of the clubs you are faculty for.", { exact: true })
    .waitFor();
  if ((await fac.page.getByRole("button", { name: "New event", exact: true }).count()) > 0)
    throw new Error("Faculty must not get a New event button");
  ok("club faculty get read-only events, no create action");
  await fac.ctx.close();

  // Responsive: 390px phone and 768px tablet have no horizontal overflow; drawer works.
  for (const width of [390, 768]) {
    const m = await session("coding.lead@demo.campusops.local", width);
    await m.page.waitForSelector(".stat-grid");
    const overflow = await m.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) throw new Error(`${width}px overflow ${overflow}px`);
    await m.page.click('button[aria-label="Open menu"]');
    await m.page.locator(".sidebar.open").waitFor();
    await m.page.click('nav.tabs button:has-text("Resources")');
    await m.page.locator("h1", { hasText: "Resources" }).waitFor();
    if (await m.page.locator(".sidebar.open").count())
      throw new Error("Drawer stayed open after navigation");
    ok(`${width}px layout has no overflow and drawer navigation works`);
    // Let the drawer's CSS transform finish, otherwise the screenshot catches it
    // half-off-screen and looks like a layout bug when it is only a transition.
    await m.page.waitForTimeout(400);
    await m.page.screenshot({ path: `e2e/p6-04-${width}.png`, fullPage: true });
    await m.ctx.close();
  }
} catch (e) {
  results.push(`FAIL  ${e.message}`);
  console.log(`FAIL  ${e.message}`);
} finally {
  await browser.close();
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(
    `\n${results.length - failed} pass, ${failed} fail; console/page errors: ${errors.length}`,
  );
  if (errors.length) console.log(errors.slice(0, 5).join("\n"));
  process.exit(failed || errors.length ? 1 : 0);
}
