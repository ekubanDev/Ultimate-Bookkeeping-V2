import { defineConfig } from "vitest/config";

/**
 * vitest config for @ub/shared-ui.
 *
 * environment: "node" — the only thing currently tested here is money.js,
 * which is pure string formatting with no DOM involvement. The Button/Input/
 * Modal primitives are exercised through the outlet app's own jsdom suite,
 * where they are rendered in context rather than in isolation. Switch this
 * to "jsdom" if a primitive ever grows behaviour worth testing on its own.
 */
export default defineConfig({
  test: {
    environment: "node",
  },
});
