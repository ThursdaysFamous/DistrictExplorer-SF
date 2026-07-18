// Headless boot smoke test — SF Thread-5 (pipeline: legislative geometry + rosters).
// Serves the real index.html and drives it in Chromium via Playwright
// (.github/workflows/smoke-test.yml on every PR). Asserts both the network-free
// deliverables and the offline classification: the app boots on the SF map,
// registers EXPECT_LAYERS layers with no console errors, is SF-branded, and
// degrades a base-map tile outage to a dismissible banner; the three offline
// anchors (supervisor / neighborhood / police-district) classify SF City Hall
// against the ground truth from same-origin data/app files, and the negative Bay
// point honestly reports no district (never snaps to nearest); the three
// legislative chambers (U.S. House / CA Senate / CA Assembly) classify City Hall
// from pre-built, SF-clipped same-origin geometry AND name the officeholder from
// a scraped same-origin roster. The ZIP stub and the station + schools layers
// remain live DataSF/TIGERweb — not reachable from CI/sandbox — so they are
// asserted present (registered) only (this gate is re-derived each thread —
// docs/METRO_EXPANSION_PLAYBOOK.md §9).
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
const NEGATIVE_POINT = "37.74000,-122.59000"; // Open Pacific west of Ocean Beach, beyond CA state waters - outside every layer, including the water-inclusive TIGERweb legislative chambers
const EXPECT_LAYERS = 11; // Thread-5: legislative chambers now pre-built SF-clipped geometry (data/app); supervisor-district is a bespoke roster-joined registerLayer; 11 layers total
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
  // 1. App boots on the SF map with the Thread-5 layers, SF-branded, clean console.
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

    // The station + schools layers are live DataSF — assert they register (a
    // toggle exists); their classification can't run without network egress.
    const safetyPtsOk = await page.evaluate(() =>
      !!document.getElementById("toggle-police-station") && !!document.getElementById("toggle-fire-station"));
    check("police + fire station layers present", safetyPtsOk);
    const schoolsOk = await page.evaluate(() =>
      !!document.getElementById("toggle-elementary-attendance-area") && !!document.getElementById("toggle-school-site"));
    check("elementary-zone + school-site layers present", schoolsOk);
    // (The three legislative chambers are asserted by offline classification in
    // block 2c below, now that their geometry is pre-built same-origin.)

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

  // 2c. The three legislative chambers classify City Hall from pre-built,
  //     SF-clipped same-origin geometry (data/app), and now name the officeholder
  //     from the scraped same-origin roster (data/app/*-members.json / roster).
  //     They use water-inclusive TIGERweb boundaries, so — unlike the
  //     shoreline-clipped anchors — they legitimately DO contain the negative Bay
  //     point (§7); they are checked positive-only here, deliberately not in the
  //     negative-point block above. The specific names change week to week, so we
  //     assert the member's ROLE label (proof a roster row joined), not a name.
  {
    const CHAMBERS = {
      "congress": { district: "11", role: "Representative" },
      "ca-senate": { district: "11", role: "State Senator" },
      "ca-assembly": { district: "17", role: "Assemblymember" },
    };
    const ids = Object.keys(CHAMBERS);
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await routeLeaflet(page);
    await page.goto(`${BASE}#point=${POINT}&layers=${ids.join(",")}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.SFExplorer, null, { timeout: BOOT_TIMEOUT });
    for (const id of ids) {
      const c = await cardText(page, id);
      const { district, role } = CHAMBERS[id];
      check(`${id} classifies City Hall (District ${district}) + names its ${role}`,
        !c.error && c.text.includes(district) && c.text.includes(role), c.text.slice(0, 90));
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
console.log("\nAll SF Thread-5 smoke checks passed.");
