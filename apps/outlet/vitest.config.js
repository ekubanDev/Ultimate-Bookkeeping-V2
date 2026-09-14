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
 *
 * env: VITE_FIREBASE_* are forced blank so the suite is HERMETIC — it must
 * behave identically whether or not the developer has a .env.local, which
 * README's own setup step ("cp .env.example .env.local") tells them to
 * create. Vitest inherits Vite's env loading, so without this override a
 * populated .env.local leaks real config into `import.meta.env`, making
 * src/auth/firebase.js's module-level `isFirebaseConfigured` true and
 * failing the three loadFirebaseAuth tests that assert the unconfigured
 * path. Worse than a red suite: those tests exist to prove the Firebase SDK
 * is NEVER imported when unconfigured, and with real config present they
 * were silently initializing the live SDK — the assertion's own subject.
 * Blank (not absent) because resolveFirebaseConfig treats "" as missing,
 * which is the condition under test.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.js"],
    env: {
      VITE_FIREBASE_API_KEY: "",
      VITE_FIREBASE_AUTH_DOMAIN: "",
      VITE_FIREBASE_PROJECT_ID: "",
      VITE_FIREBASE_AUTH_EMULATOR_HOST: "",
    },
  },
});
