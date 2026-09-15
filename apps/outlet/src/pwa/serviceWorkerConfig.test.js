/**
 * Service-worker configuration invariants (vite.config.js).
 *
 * Regression cover for a bug found on the live deployment: in a fresh
 * session, navigating away from the POS screen while offline hung on the
 * Suspense fallback forever.
 *
 * The service worker registered and precached correctly — including the
 * React.lazy() route chunks — but `clientsClaim` was absent, so the worker
 * never took control of the page that installed it. An uncontrolled page
 * bypasses the service worker entirely, so those chunk requests went to the
 * network and failed with no route ever rendering and no error surfaced.
 *
 * The failure was specific rather than general, which is what made it
 * confusing: PosScreen is a STATIC import and ships inside the main bundle,
 * so it kept working offline. Only the lazily-loaded routes broke, and only
 * until the next reload, after which the worker was in control and
 * everything behaved.
 *
 * These assertions are read off the config source rather than a built
 * artifact so they run in the normal suite with no build step. The property
 * they protect is a build-time setting, and the environment where it matters
 * — a first-install session that then goes offline — is one no unit test can
 * reach.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const configSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../vite.config.js"),
  "utf8"
);

/** Strips line and block comments so assertions match real config, not prose. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const config = stripComments(configSource);

describe("service worker configuration", () => {
  it("claims clients, so the installing page is controlled without a reload", () => {
    expect(config).toMatch(/clientsClaim:\s*true/);
  });

  it("does not enable skipWaiting, which would swap JS out from under an open cart", () => {
    // 'prompt' registration exists precisely so an update activates only
    // when the cashier confirms. clientsClaim is safe alongside it — it acts
    // on activation, and an updated worker still waits — but an explicit
    // `skipWaiting: true` here would remove that gate.
    expect(config).not.toMatch(/skipWaiting:\s*true/);
    expect(config).toMatch(/registerType:\s*["']prompt["']/);
  });

  it("precaches JS, so React.lazy route chunks are available offline", () => {
    const glob = config.match(/globPatterns:\s*\[([^\]]+)\]/);
    expect(glob).not.toBeNull();
    expect(glob[1]).toMatch(/js/);
    expect(glob[1]).toMatch(/html/);
  });

  it("falls back to the app shell for deep-link navigations, but never for /api", () => {
    expect(config).toMatch(/navigateFallback:\s*["']\/index\.html["']/);
    expect(config).toMatch(/navigateFallbackDenylist/);
  });
});
