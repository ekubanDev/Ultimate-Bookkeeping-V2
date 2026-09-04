import { describe, expect, it } from "vitest";
import { resolveFirebaseConfig } from "./firebase.js";

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
