import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises the Auth-emulator branch added to loadFirebaseAuth() (see
 * firebase.js's AUTH EMULATOR doc comment). Kept in its own file rather
 * than folded into firebase.test.js: that suite relies on this app's real,
 * unstubbed test env being "unconfigured" (no VITE_FIREBASE_* set) to
 * exercise the `isFirebaseConfigured === false` short-circuit — mixing in
 * `vi.stubEnv`/`vi.resetModules` here keeps that env-pollution risk fully
 * contained to this file.
 *
 * firebase.js reads `config` (and `isFirebaseConfigured`) from
 * `import.meta.env` at MODULE-EVALUATION time, not lazily — so getting a
 * "configured" instance of the module requires stubbing the env vars
 * *before* importing it, then `vi.resetModules()` so the next dynamic
 * `import()` re-evaluates the module body against the stubbed env instead
 * of returning a cached instance from an earlier test/file.
 *
 * `firebase/app` and `firebase/auth` are mocked rather than hitting the
 * real SDK (which would try real network calls) — this test only asserts
 * on *wiring* (does loadFirebaseAuth call connectAuthEmulator, with what
 * args, in what order relative to getAuth), which is exactly what a unit
 * test should assert here; the SDK's own emulator-connection behavior is
 * Firebase's to test, not this app's.
 */

const initializeApp = vi.fn(() => ({ name: "[DEFAULT]" }));
const getAuth = vi.fn((app) => ({ app, currentUser: null }));
const connectAuthEmulator = vi.fn();
const onAuthStateChanged = vi.fn();
const signInWithEmailAndPassword = vi.fn();
const signOut = vi.fn();

vi.mock("firebase/app", () => ({
  initializeApp: (...args) => initializeApp(...args),
}));

vi.mock("firebase/auth", () => ({
  getAuth: (...args) => getAuth(...args),
  connectAuthEmulator: (...args) => connectAuthEmulator(...args),
  onAuthStateChanged: (...args) => onAuthStateChanged(...args),
  signInWithEmailAndPassword: (...args) => signInWithEmailAndPassword(...args),
  signOut: (...args) => signOut(...args),
}));

const REQUIRED_ENV = {
  VITE_FIREBASE_API_KEY: "demo-api-key",
  VITE_FIREBASE_AUTH_DOMAIN: "localhost",
  VITE_FIREBASE_PROJECT_ID: "demo-ultimate-bookkeeping",
};

async function importFreshFirebaseModule() {
  vi.resetModules();
  return import("./firebase.js");
}

beforeEach(() => {
  initializeApp.mockClear();
  getAuth.mockClear();
  connectAuthEmulator.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadFirebaseAuth — auth emulator wiring", () => {
  it("never calls connectAuthEmulator when VITE_FIREBASE_AUTH_EMULATOR_HOST is unset", async () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    // Explicit, not just "absent from REQUIRED_ENV" — guards against test
    // order/pollution from a previous stub leaking in.
    vi.stubEnv("VITE_FIREBASE_AUTH_EMULATOR_HOST", "");

    const { isFirebaseConfigured, loadFirebaseAuth } = await importFreshFirebaseModule();
    expect(isFirebaseConfigured).toBe(true);

    const result = await loadFirebaseAuth();

    expect(getAuth).toHaveBeenCalledTimes(1);
    expect(connectAuthEmulator).not.toHaveBeenCalled();
    expect(result.auth).toBe(getAuth.mock.results[0].value);
  });

  it("calls connectAuthEmulator with a full URL built from the bare host:port env var, after getAuth", async () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("VITE_FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");

    const { loadFirebaseAuth } = await importFreshFirebaseModule();
    const result = await loadFirebaseAuth();

    expect(connectAuthEmulator).toHaveBeenCalledTimes(1);
    expect(connectAuthEmulator).toHaveBeenCalledWith(result.auth, "http://127.0.0.1:9099");

    // Ordering: getAuth must have already run (and produced the instance
    // passed to connectAuthEmulator) before connectAuthEmulator is called —
    // the SDK only allows connecting the emulator before the auth instance
    // has made any request, but getAuth() itself must run first to exist
    // at all.
    const getAuthOrder = getAuth.mock.invocationCallOrder[0];
    const connectOrder = connectAuthEmulator.mock.invocationCallOrder[0];
    expect(getAuthOrder).toBeLessThan(connectOrder);
  });

  it("is safe to call repeatedly in emulator mode (memoized, connects once)", async () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("VITE_FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");

    const { loadFirebaseAuth } = await importFreshFirebaseModule();
    await loadFirebaseAuth();
    await loadFirebaseAuth();

    expect(getAuth).toHaveBeenCalledTimes(1);
    expect(connectAuthEmulator).toHaveBeenCalledTimes(1);
  });
});
