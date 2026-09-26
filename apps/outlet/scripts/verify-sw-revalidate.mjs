/**
 * Does a price change actually reach the till on the SECOND catalog load?
 *
 * The runbook claims it does, and that the `maxAgeSeconds: 86400` in the
 * build is a cache EXPIRY rather than a staleness window — i.e. a price
 * change is one extra screen-open away, not a day. That claim was derived by
 * reading vite.config.js, useProducts.js and the generated dist/sw.js. Never
 * observed. This script observes it.
 *
 * WHY NOT DRIVE THE UI: the POS sits behind Firebase auth, and standing up an
 * emulator plus a seeded user would test a great deal that is not in
 * question. The claim is about one thing — what the service worker returns
 * for GET /api/v1/products when the upstream response has changed — so this
 * calls fetch() directly from the page, which the service worker intercepts
 * exactly as it does for useProducts. Same route, same handler, same cache.
 *
 * WHAT IT DOES:
 *   1. serves the real production build from dist/ plus a stub /api/v1/products
 *   2. loads the page and waits for the service worker to take control
 *   3. fetches the catalog  -> warms the cache at the OLD price
 *   4. changes the stub's price
 *   5. fetches again        -> expect the OLD price (served stale)
 *   6. fetches again        -> expect the NEW price (revalidated in step 5)
 *
 * Step 6 failing would mean the runbook is wrong and the price really is
 * held for maxAgeSeconds. Step 5 returning the NEW price would mean the
 * route is not being cached at all — which is the bug the anchored-regex fix
 * addressed, and would mean it had regressed.
 *
 *   node apps/outlet/scripts/verify-sw-revalidate.mjs
 *
 * Requires a built dist/ (npm run build:outlet) and Chrome installed.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const step = (m) => { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
const PORT = 4183;

const OLD_PRICE = "45.00";
const NEW_PRICE = "99.00";
let currentPrice = OLD_PRICE;
let apiHits = 0;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

function serve() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname.startsWith("/api/v1/products")) {
      apiHits += 1;
      res.writeHead(200, {
        "Content-Type": "application/json",
        // No HTTP caching — the only cache under test is the service worker's.
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify([
          { id: "p1", sku: "MILO", name: "Milo 400g", unit_price: currentPrice, min_stock: null },
        ])
      );
      return;
    }

    let filePath = path.join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, "index.html");
    }
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] ?? "application/octet-stream",
      // The SW file itself must never be cached by the browser or step 2
      // can hang waiting for a worker that is already stale.
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
}

const fetchPrice = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/v1/products?outlet_id=outlet-1");
    const body = await res.json();
    return body[0].unit_price;
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(path.join(DIST, "sw.js"))) {
    console.error("No dist/sw.js — run `npm run build:outlet` first.");
    process.exit(2);
  }

  step("starting static server");
  const server = serve();
  // A previous aborted run can leave the port held; say so plainly instead of
  // dying with a bare EADDRINUSE stack, which is what happened the first time.
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use — an earlier run may still be alive.\n` +
          `  lsof -ti :${PORT} | xargs kill -9`
      );
      process.exit(2);
    }
    throw err;
  });
  await new Promise((r) => server.listen(PORT, r));
  step(`server listening on ${PORT}`);

  step("launching chrome");
  const browser = await chromium.launch({ channel: "chrome" });
  step("chrome launched");
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => step(`page console: ${m.text()}`));
  page.on("pageerror", (e) => step(`page error: ${e.message}`));
  step("page ready");
  const failures = [];

  try {
    step("navigating");
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    step("navigated");

    // clientsClaim is set, so the worker takes control of this very page.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
      timeout: 20000,
    });
    console.log("service worker is controlling the page");

    const first = await fetchPrice(page);
    console.log(`  1st fetch (warms cache)      -> ${first}`);
    if (first !== OLD_PRICE) failures.push(`1st fetch expected ${OLD_PRICE}, got ${first}`);

    // The shopkeeper's price change lands on the server.
    currentPrice = NEW_PRICE;
    console.log(`  --- price changed upstream to ${NEW_PRICE} ---`);

    const second = await fetchPrice(page);
    console.log(`  2nd fetch (expect STALE)     -> ${second}`);
    if (second !== OLD_PRICE) {
      failures.push(
        `2nd fetch expected the stale ${OLD_PRICE}, got ${second} — ` +
          "the products route may not be cached at all"
      );
    }

    // Revalidation is fire-and-forget; give it a moment to land in the cache.
    await sleep(1500);

    const third = await fetchPrice(page);
    console.log(`  3rd fetch (expect FRESH)     -> ${third}`);
    if (third !== NEW_PRICE) {
      failures.push(
        `3rd fetch expected the new ${NEW_PRICE}, got ${third} — ` +
          "the runbook's 'second load' claim is WRONG"
      );
    }

    console.log(`  upstream was hit ${apiHits} times`);
  } finally {
    await browser.close();
    server.close();
  }

  console.log("");
  if (failures.length === 0) {
    console.log("PASS — a price change reaches the till on the next catalog load.");
    process.exit(0);
  }
  console.log("FAIL");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
