import { describe, expect, it } from "vitest";
import { isFirebaseConfigured, loadFirebaseAuth, resolveFirebaseConfig } from "./firebase.js";

describe("resolveFirebaseConfig", () => {
  it("returns the resolved config when all three vars are present", () => {
    const env = { apiKey: "key-1", authDomain: "example.firebaseapp.com", projectId: "proj-1" };
    expect(resolveFirebaseConfig(env)).toEqual({
      apiKey: "key-1",
      authDomain: "example.firebaseapp.com",
      projectId: "proj-1",
    });
  });

  it("returns null when apiKey is missing", () => {
    expect(resolveFirebaseConfig({ authDomain: "d", projectId: "p" })).toBeNull();
  });

  it("returns null when authDomain is missing", () => {
    expect(resolveFirebaseConfig({ apiKey: "k", projectId: "p" })).toBeNull();
  });

  it("returns null when projectId is missing", () => {
    expect(resolveFirebaseConfig({ apiKey: "k", authDomain: "d" })).toBeNull();
  });

  it("returns null for an empty/blank var, not a falsy-but-present one", () => {
    expect(resolveFirebaseConfig({ apiKey: "", authDomain: "d", projectId: "p" })).toBeNull();
  });

  it("returns null when given no env object at all", () => {
    expect(resolveFirebaseConfig(undefined)).toBeNull();
  });
});

describe("loadFirebaseAuth", () => {
  // No .env is loaded for tests (see .env.example — VITE_FIREBASE_* is
  // unset here), so isFirebaseConfigured is false in this suite the same
  // way it would be for a real unconfigured deployment. That's exactly the
  // path this test exercises: it doesn't require mocking the Firebase SDK
  // at all, because loadFirebaseAuth() must resolve to null WITHOUT ever
  // attempting the dynamic import("firebase/auth") when unconfigured —
  // the whole point of keeping isFirebaseConfigured a synchronous, SDK-free
  // check (see firebase.js's bundle-size note).
  it("confirms this environment is unconfigured, matching production's 'no .env vars set' case", () => {
    expect(isFirebaseConfigured).toBe(false);
  });

  it("resolves to null, with no SDK import attempted, when Firebase isn't configured", async () => {
    await expect(loadFirebaseAuth()).resolves.toBeNull();
  });

  it("is safe to call repeatedly while unconfigured (still resolves null every time)", async () => {
    await expect(loadFirebaseAuth()).resolves.toBeNull();
    await expect(loadFirebaseAuth()).resolves.toBeNull();
  });
});
