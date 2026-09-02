import { defineConfig } from "vitest/config";

/**
 * vitest config for @ub/api-client.
 *
 * environment: "node" — mirrors @ub/offline-queue's config in spirit (no DOM
 * dependency here either). `fetch` is stubbed per-test via vi.stubGlobal
 * rather than a polyfill, since we're only asserting on the request this
 * package builds, never actually hitting a network.
 */
export default defineConfig({
  test: {
    environment: "node",
  },
});
