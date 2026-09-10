import { defineConfig } from "vitest/config";

/**
 * vitest config for @ub/offline-queue.
 *
 * environment: "node" — deliberately NOT jsdom. This package has no DOM
 * dependency of its own; `window`/`navigator` are feature-detected and
 * guarded (see index.js#onReconnect, #scheduleRetry, #isOnline) so tests
 * exercise the same "no ambient browser" code paths a Node/SSR context
 * would hit. IndexedDB itself is polyfilled per-test via fake-indexeddb
 * (see test/setup.js).
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.js"],
  },
});
