import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import {
  OTHER_API_PATTERN,
  PRODUCTS_READ_PATTERN,
  STOCK_LEVELS_READ_PATTERN,
} from "./src/pwa/apiCacheRoutes.js";

/**
 * Vite config for the Outlet app.
 *
 * Build tool decision: Vite, chosen provisionally by Kojo per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §6 open item ("Confirm build
 * tool (Vite vs. CRA/craco carryover)"). Reversible — flagged in the
 * scaffold report, not yet signed off by Kwame.
 *
 * Kept deliberately small: this app targets cheap Android devices on bad
 * connections, so bundle size matters more than build-tool flexibility.
 *
 * SERVICE WORKER (Kojo, 2026-09): this repo previously had no service
 * worker at all — a durable offline WRITE path (packages/offline-queue,
 * IndexedDB) sitting under an app shell that couldn't survive a reload or
 * relaunch while offline. vite-plugin-pwa (Workbox under the hood) closes
 * that gap. Chose it over a hand-rolled SW because precaching a
 * content-hashed Vite build correctly (never missing/staling a chunk) is
 * exactly Workbox's `injectManifest`/`generateSW` job — reimplementing
 * cache-busting-by-hash and the install/activate/claim lifecycle by hand
 * buys nothing here and is much easier to get subtly wrong. `generateSW`
 * (not `injectManifest`) is enough: every runtime-caching rule this app
 * needs (see below) is expressible declaratively, so there's no custom SW
 * logic that would require hand-writing the worker source.
 *
 * See src/pwa/UpdatePrompt.jsx and src/pwa/updatePromptMachine.js for the
 * update-lifecycle handling this config feeds into, and
 * src/pwa/apiCacheRoutes.js (imported below) for the runtime-caching
 * route patterns and their test coverage.
 */
export default defineConfig(({ mode }) => {
  // Loads every .env* var for this mode into a plain object, regardless of
  // VITE_ prefix (loadEnv, unlike import.meta.env in client code, doesn't
  // filter by prefix) — DEV_API_PROXY_TARGET below is deliberately NOT
  // VITE_-prefixed (see the proxy comment) so it never leaks into the
  // client bundle; loadEnv is the only way for this Node-side config file
  // to read it.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      react(),
      VitePWA({
        // generateSW: Workbox generates the whole service worker from this
        // config (precache manifest + the runtime-caching routes below).
        // No custom SW source needed — see file-level note above.
        strategies: "generateSW",

        // 'prompt', not 'autoUpdate': a precached SW otherwise pins a
        // cashier to whatever build was installed until *something* tells
        // the browser to activate the new one. 'autoUpdate' would call
        // skipWaiting()/clients.claim() the moment a new build is detected —
        // on a POS mid-sale that means the running JS can be swapped out
        // from under an open cart without warning. 'prompt' instead surfaces
        // needRefresh via useRegisterSW (see src/pwa/UpdatePrompt.jsx) and
        // only activates the new SW when the cashier confirms — see that
        // file for the full lifecycle writeup and why "update on next cold
        // start" alone wasn't chosen instead.
        registerType: "prompt",

        // Explicit rather than the vite-plugin-pwa default injected
        // registration snippet: src/pwa/UpdatePrompt.jsx registers the SW
        // itself via `virtual:pwa-register/react` so registration is tied to
        // the same component that owns the update-prompt UI/state machine.
        injectRegister: false,

        manifest: {
          // §5 (installability): cheap to add now, doesn't block the later
          // Capacitor/PWA-wrapper step mentioned in the UI plan — a manifest
          // is additive, not a commitment to ship as an installed PWA yet.
          name: "Ultimate Bookkeeping — Outlet",
          short_name: "UB Outlet",
          description:
            "Ultimate Bookkeeping v2 Outlet app: POS, stock, and expenses for one outlet manager.",
          // Deep indigo / amber — placeholder brand colours (see
          // public/pwa-*.png generation note), not a signed-off Tesseract
          // brand asset; swap when Ama/design has one.
          theme_color: "#1e1b4b",
          background_color: "#1e1b4b",
          display: "standalone",
          start_url: "/",
          scope: "/",
          icons: [
            { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
            { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/pwa-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },

        // vite-plugin-pwa's manifest icons are already covered by
        // workbox.globPatterns below (png is in the glob and the icons live
        // in dist/ after the build copies public/) — without this, the
        // plugin's default `includeManifestIcons: true` double-lists each
        // icon (and manifest.webmanifest) in the generated precache manifest
        // under two identical {url, revision} entries. Harmless at runtime
        // (Workbox dedupes by URL) but confusing to audit and not what "one
        // real manifest, generated once from the actual build output" should
        // look like — turned off so `dist/sw.js`'s precache list matches
        // `dist/` 1:1.
        includeManifestIcons: false,

        workbox: {
          // Precache the actual build manifest (hashed filenames), generated
          // at build time by Workbox from Vite's own output — never a
          // hand-maintained list, so it can't silently go stale as chunks
          // are added/renamed/removed. This is what makes a cold offline
          // reload able to serve the shell at all.
          //
          // No 'webmanifest' extension here: vite-plugin-pwa always injects
          // the generated manifest.webmanifest into the precache list itself
          // (installability requires it, independent of this glob) — adding
          // it here too just re-lists the identical {url, revision} entry a
          // second time.
          globPatterns: ["**/*.{js,css,html,svg,png,ico}"],

          // SPA fallback: a direct/deep-link navigation (e.g. reloading on
          // /stock, or the OS relaunching the app on its last route) while
          // offline must still resolve to the precached shell so
          // react-router can take over client-side, exactly like the dev
          // server's SPA fallback already does online.
          navigateFallback: "/index.html",
          // Never let the SPA fallback intercept API calls — it only
          // applies to 'navigate'-mode requests (top-level HTML navigation)
          // so a fetch()'d /api/v1/... call wouldn't match it anyway, but
          // this makes the exclusion explicit rather than relying on that
          // implicit distinction.
          navigateFallbackDenylist: [/^\/api\//],

          // RUNTIME CACHING — deliberately narrow. Workbox route `method`
          // defaults to 'GET' per entry, and any request that matches no
          // route here is left completely untouched by the service worker
          // (no respondWith(), straight to network) — so every POST in this
          // app (sales, stock adjustments, expenses, void) is already
          // excluded from SW caching/replay by omission, not just by the
          // NetworkOnly rule below. That NetworkOnly rule exists anyway, as
          // a explicit, load-bearing statement of intent: this SW must NEVER
          // own a second replay path for mutations — packages/offline-queue
          // already owns idempotent replay via client_id, and a SW-level
          // background-sync retry on top of that would be a correctness
          // disaster (double-submitted sales). See CLAUDE.md + design doc §3.
          runtimeCaching: [
            // GET /api/v1/products — the POS catalog. Cached
            // StaleWhileRevalidate: serve the last-known catalog instantly
            // (works offline), kick off a background revalidation whenever
            // online. Judged safe to cache because pricing is
            // server-authoritative at POST /sales time regardless of what
            // the client last saw (see api-client's salesApi.js +
            // useSubmitSale.js) — a stale cached price only affects what's
            // *displayed* while adding to cart; the actual charge is
            // recomputed server-side, and any mismatch is surfaced later via
            // the existing price_variance_flagged admin-review signal
            // (SyncBanner already renders it). That safety net is what makes
            // "sell from a cached catalog while offline" a genuine win
            // instead of a silent-staleness risk.
            {
              urlPattern: PRODUCTS_READ_PATTERN,
              method: "GET",
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "ub-products-cache",
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24, // 1 day — outlets don't re-catalog intraday
                },
                cacheableResponse: { statuses: [200] },
              },
            },

            // GET /api/v1/stock/levels — deliberately NOT cached; left
            // NetworkOnly (explicit, not just "unmatched"). Unlike products,
            // there is no server-side correction step downstream: stock
            // levels are read once, shown as current on-hand quantity, and
            // used directly to *decide* a stock adjustment (StockLevelList's
            // low-stock cue, AdjustmentModal). A stale cached quantity here
            // has no equivalent to the products-price safety net — the
            // outlet manager could act on a wrong number with nothing to
            // catch it. Caching this safely needs a staleness-visible UI
            // ("showing last known data from HH:MM") which is a real feature
            // addition, not a caching-config change — out of scope for this
            // pass per the task's own fallback option. Left network-only:
            // offline, useStockLevels' existing error state fires exactly as
            // it does today, same failure mode as before this change, not a
            // new (worse) one. Revisit alongside a staleness-indicator
            // component if/when this is prioritized.
            {
              urlPattern: STOCK_LEVELS_READ_PATTERN,
              method: "GET",
              handler: "NetworkOnly",
            },

            // Explicit belt-and-suspenders NetworkOnly catch-all for every
            // other GET /api/v1/* request (GET /me, GET /sales — Workbox
            // route `method` defaults to 'GET', so this still doesn't touch
            // POST at all; POST stays excluded purely by non-match, as
            // above). Not strictly required (unmatched requests already
            // bypass the SW, see the comment above runtimeCaching), but
            // keeps the "reads outside the explicit allowlist above are
            // never cached" guarantee legible directly in this config
            // instead of resting on an implicit default, and future-proofs
            // it if someone later adds a broader catch-all cache rule above
            // this one without reading this comment.
            {
              urlPattern: OTHER_API_PATTERN,
              handler: "NetworkOnly",
            },
          ],
        },
      }),
    ],
    server: {
      port: 5173,
      proxy: {
        // DEV-ONLY API PROXY (Kojo, 2026-09): closes the hard blocker where
        // the dev server had no way to reach the FastAPI backend at all.
        //
        // packages/api-client/_base.js deliberately hardcodes
        // `API_BASE = "/api/v1"` — a *relative*, same-origin path, not an
        // absolute `http://localhost:8000/api/v1` URL. That was a Nana
        // (Security) sign-off, not a Kojo convenience shortcut: same-origin
        // means the browser only ever attaches the Firebase bearer token
        // (set via apiFetch's Authorization header) to whatever origin the
        // app itself was served from. If API_BASE were absolute, EVERY
        // deployment (dev, staging, prod) would be one misconfigured/copied
        // env var away from silently sending a live bearer token to the
        // wrong origin — a third-party host, a stale staging URL, a typo.
        // Relative + proxy makes that class of leak structurally impossible
        // instead of policy-dependent. DO NOT "simplify" this by pointing
        // API_BASE at an absolute backend URL — see api-client's _base.js
        // for the matching comment on that side.
        //
        // So in dev, something still has to get a same-origin-looking
        // `/api/v1/...` fetch to the actual backend process — that's this
        // block. Vite's dev-server proxy rewrites the request server-side
        // (Node, not the browser), so the browser never sees a cross-origin
        // URL and the same-origin property above is preserved end to end;
        // only the dev server's own outbound hop is redirected.
        //
        // Target is configurable (DEV_API_PROXY_TARGET, read via loadEnv
        // above) rather than hardcoded, defaulting to
        // http://localhost:8000 where Efua documents running the API
        // locally (see apps/api's README / ultimate-bookkeeping-v2-api-
        // contracts.md) — so a developer running the API on a different
        // port (or in a container/VM with a different host) isn't stuck
        // editing this file. Deliberately NOT VITE_-prefixed: this value is
        // only ever read here, in Node, by loadEnv — it has no reason to be
        // exposed to client code via import.meta.env, and VITE_-prefixing
        // it would do exactly that for no benefit.
        //
        // changeOrigin: true rewrites the Host header to match the proxy
        // target — harmless and standard for a local dev proxy; irrelevant
        // in production, where this whole `server.proxy` block never runs
        // (Vite's dev-server config has no effect on `vite build`/`vite
        // preview` output — see the build note below).
        "/api": {
          target: env.DEV_API_PROXY_TARGET || "http://localhost:8000",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      // NOTE: this proxy is dev-server-only (`vite`/`npm run dev`), not part
      // of the production build — `vite build` output is static assets with
      // no server component, so the deployed same-origin property above
      // must come from real infra (the API and the built SPA served under
      // one origin, e.g. via a reverse proxy) — that's a deployment concern
      // outside this app, not something vite.config.js can express.
    },
  };
});
