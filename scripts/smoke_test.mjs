// Headless boot smoke test — SF Thread-0 (stub). Serves the real index.html and
// drives it in Chromium via Playwright (.github/workflows/smoke-test.yml on every
// PR). At Thread 0 the app registers a single stub layer (ZIP Code) whose data is
// a live TIGERweb query — not reachable from CI/sandbox — so this asserts only the
// network-free deliverable: the app boots on the SF map, registers EXPECT_LAYERS
// layer(s) with no console errors, is SF-branded, and still degrades a base-map
// tile outage to a dismissible banner. Real classification/roster/negative-point
// checks return as SF layers with offline anchors land in later threads (which
// re-derive this gate — docs/METRO_EXPANSION_PLAYBOOK.md §9).
//
// Run locally against a static server:
//     python3 -m http.server 8000 &
//     npm install playwright && node scripts/smoke_test.mjs
// Configure the URL with BASE_URL (default http://localhost:8000/).

import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Vendored Leaflet fallback for sandboxed environments (Claude Code web), where
// Chromium cannot reach cdnjs.cloudflare.com (it does not use the agent HTTPS
// proxy, so the request resets and the app never boots — "L is not defined").
// scripts/vendor_leaflet.sh populates this dir via curl, which *can* reach the CDN
// through the proxy; when present we serve Leaflet same-origin below. Absent
// (production, GitHub Actions CI) the browser loads Leaflet from the CDN as before.
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "vendor", "leaflet");
const VENDORED_LEAFLET =
  existsSync(join(VENDOR_DIR, "leaflet.js")) && existsSync(join(VENDOR_DIR, "leaflet.css"))
    ? { js: readFileSync(join(VENDOR_DIR, "leaflet.js")), css: readFileSync(join(VENDOR_DIR, "leaflet.css")) }
    : null;
if (VENDORED_LEAFLET) console.log("  (serving Leaflet from scripts/vendor/leaflet — CDN unreachable in this env)");

const BASE = process.env.BASE_URL || "http://localhost:8000/";
// ==== GENERATED:BEGIN smoke-config ====
const POINT = "37.77927,-122.41924"; // SF City Hall (Civic Center)
const OFFLINE = ["supervisor-district", "neighborhood", "police-district"];
const EXPECT_DISTRICT = { "supervisor-district": "5", "neighborhood": "Tenderloin", "police-district": "NORTHERN" };
const NEGATIVE_POINT = "37.80000,-122.35500"; // San Francisco Bay (open water east of the Embarcadero) - outside all shoreline-clipped anchors
const EXPECT_LAYERS = 4; // Thread-1: 3 offline anchors (supervisor/police/neighborhood) + the ZIP stub
// ==== GENERATED:END smoke-config ====
const BOOT_TIMEOUT = 45000; // Leaflet + first paint on a cold CI runner
const QUERY_TIMEOUT = 25000;

const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(name);
}

function routeLeaflet(page) {
  if (!VENDORED_LEAFLET) return Promise.resolve();
  return Promise.all([
    page.route("**/cdnjs.cloudflare.com/**/leaflet.js", (r) =>
      r.fulfill({ status: 200, contentType: "application/javascript", body: VENDORED_LEAFLET.js })),
    page.route("**/cdnjs.cloudflare.com/**/leaflet.css", (r) =>
      r.fulfill({ status: 200, contentType: "text/css", body: VENDORED_LEAFLET.css })),
  ]);
}

async function cardText(page, id) {
  await page.waitForFunction((cid) => {
    const el = document.getElementById("card-" + cid);
    return el && !el.querySelector(".loading-row") &&
      (el.querySelector(".result-fields") || el.querySelector(".state-empty") ||
       el.classList.contains("state-empty") || el.classList.contains("state-error") || el.querySelector(".state-error"));
  }, id, { timeout: QUERY_TIMEOUT }).catch(() => {});
  return page.evaluate((cid) => {
    const el = document.getElementById("card-" + cid);
    if (!el) return { text: "(no card)", error: true, empty: false };
    return {
      text: el.innerText.replace(/\s+/g, " ").trim(),
      error: el.classList.contains("state-error") || !!el.querySelector(".state-error"),
      empty: el.classList.contains("state-empty") || !!el.querySelector(".state-empty"),
    };
  }, id);
}

const browser = await chromium.launch();
try {
  // 1. App boots on the SF map with the Thread-1 layers, SF-branded, clean console.
  {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      // Ignore sandbox network unreachability — the CARTO basemap tiles (and, absent
      // the vendored fallback, the Leaflet CDN) aren't routable from CI/sandbox. We
      // care about *app* JS errors (a dangling ref surfaces as a pageerror below).
      if (/Failed to load resource|net::ERR|cartocdn|cdnjs\.cloudflare|basemaps/i.test(t)) return;
      consoleErrors.push(t);
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await routeLeaflet(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.SFExplorer, null, { timeout: BOOT_TIMEOUT });
    check("app boots (window.SFExplorer exported)", true);

    const n = await page.evaluate(() => document.querySelectorAll('input[type=checkbox][id^="toggle-"]').length);
    check(`${EXPECT_LAYERS} layer(s) registered`, n === EXPECT_LAYERS, `found ${n}`);

    const hasMap = await page.evaluate(() => {
      const m = document.getElementById("map");
      return !!m && m.classList.contains("leaflet-container") && !!m.querySelector(".leaflet-pane");
    });
    check("Leaflet map initialized", hasMap);

    const title = await page.title();
    check("SF-branded title", /San Francisco District Explorer/.test(title), title);

    const stubOk = await page.evaluate(() => !!document.getElementById("toggle-zip-code"));
    check("ZIP Code stub layer present", stubOk);

    check("no console errors during boot", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

    if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT });
    await context.close();
  }

  // 2. The three offline anchors classify City Hall against the ground truth,
  //    from same-origin data/app/*.json (deterministic — no live API).
  {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await routeLeaflet(page);
    await page.goto(`${BASE}#point=${POINT}&layers=${OFFLINE.join(",")}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.SFExplorer, null, { timeout: BOOT_TIMEOUT });
    for (const id of OFFLINE) {
      const c = await cardText(page, id);
      const want = EXPECT_DISTRICT[id];
      check(`${id} classifies City Hall (${want})`, !c.error && c.text.includes(want), c.text.slice(0, 70));
    }
    await context.close();
  }

  // 2b. The negative Bay point misses every anchor — the honest "no district"
  //     empty state (never snap to nearest), from the same static geometry.
  {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await routeLeaflet(page);
    await page.goto(`${BASE}#point=${NEGATIVE_POINT}&layers=${OFFLINE.join(",")}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.SFExplorer, null, { timeout: BOOT_TIMEOUT });
    for (const id of OFFLINE) {
      const c = await cardText(page, id);
      check(`${id} reports no district at the Bay point`, c.empty && !c.error, c.text.slice(0, 70));
    }
    await context.close();
  }

  // 3. Base-map tile failure surfaces an honest, dismissible banner (engine behaviour).
  {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await routeLeaflet(page);
    // regex, not a glob: the tile host is `a.basemaps.cartocdn.com` (a dot, not a
    // slash, before `basemaps`), which a `**/basemaps…` glob would miss.
    await page.route(/basemaps\.cartocdn\.com/, (r) => r.fulfill({ status: 503, body: "down" }));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.SFExplorer, null, { timeout: BOOT_TIMEOUT });
    await page
      .waitForFunction(() => { const el = document.getElementById("tile-banner"); return el && !el.hidden; }, null, { timeout: QUERY_TIMEOUT })
      .catch(() => {});
    const shown = await page.evaluate(() => { const el = document.getElementById("tile-banner"); return !!el && !el.hidden; });
    let hiddenAfterDismiss = null;
    if (shown) {
      await page.click("#tile-banner-dismiss");
      hiddenAfterDismiss = await page.evaluate(() => { const el = document.getElementById("tile-banner"); return !!el && el.hidden; });
    }
    check("tile failure shows dismissible banner", shown && hiddenAfterDismiss === true, `shown=${shown} hiddenAfterDismiss=${hiddenAfterDismiss}`);
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll SF Thread-1 smoke checks passed.");
