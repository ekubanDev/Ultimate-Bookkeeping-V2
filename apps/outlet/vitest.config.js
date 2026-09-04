import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * vitest config for @ub/outlet.
 *
 * environment: "jsdom" — unlike @ub/offline-queue's node environment, this
 * app's tests render React components (PosScreen et al.) and need a DOM.
 * @ub/offline-queue itself is mocked in component tests (see
 * src/features/pos/PosScreen.test.jsx) rather than exercised for real, so
 * this config has no IndexedDB polyfill of its own to worry about.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.js"],
  },
});
