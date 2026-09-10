import { describe, expect, it, beforeEach } from "vitest";
import { cacheProfile, readCachedProfile, clearCachedProfile } from "./profileCache.js";

/**
 * profileCache — the persistence half of the offline-relaunch lockout fix
 * (AuthContext.jsx's 'signed_in_degraded' path). Uses jsdom's real
 * localStorage (see vitest.config.js — environment: "jsdom").
 */
describe("profileCache", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null for a uid that has never been cached", () => {
    expect(readCachedProfile("uid-1")).toBeNull();
  });

  it("round-trips a cached profile for a given uid", () => {
    const profile = { id: "u1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Ama" };
    cacheProfile("uid-1", profile);
    const result = readCachedProfile("uid-1");
    expect(result.profile).toEqual(profile);
    expect(typeof result.cachedAt).toBe("number");
  });

  it("keeps separate cache slots per uid — a shared device never mixes cashiers' cached profiles", () => {
    cacheProfile("uid-1", { id: "u1", display_name: "Ama" });
    cacheProfile("uid-2", { id: "u2", display_name: "Kojo" });

    expect(readCachedProfile("uid-1").profile.display_name).toBe("Ama");
    expect(readCachedProfile("uid-2").profile.display_name).toBe("Kojo");
  });

  it("last write wins for the same uid", () => {
    cacheProfile("uid-1", { id: "u1", display_name: "Ama (old)" });
    cacheProfile("uid-1", { id: "u1", display_name: "Ama (new)" });
    expect(readCachedProfile("uid-1").profile.display_name).toBe("Ama (new)");
  });

  it("clearCachedProfile removes the entry so a subsequent read is a miss", () => {
    cacheProfile("uid-1", { id: "u1", display_name: "Ama" });
    clearCachedProfile("uid-1");
    expect(readCachedProfile("uid-1")).toBeNull();
  });

  it("clearCachedProfile for one uid never touches another uid's cache", () => {
    cacheProfile("uid-1", { id: "u1", display_name: "Ama" });
    cacheProfile("uid-2", { id: "u2", display_name: "Kojo" });
    clearCachedProfile("uid-1");
    expect(readCachedProfile("uid-1")).toBeNull();
    expect(readCachedProfile("uid-2").profile.display_name).toBe("Kojo");
  });

  it("never throws and treats malformed stored JSON as a cache miss", () => {
    window.localStorage.setItem("ub-outlet:last-profile:uid-1", "{not valid json");
    expect(() => readCachedProfile("uid-1")).not.toThrow();
    expect(readCachedProfile("uid-1")).toBeNull();
  });

  it("ignores calls with no uid or no profile rather than throwing", () => {
    expect(() => cacheProfile(null, { id: "u1" })).not.toThrow();
    expect(() => cacheProfile("uid-1", null)).not.toThrow();
    expect(readCachedProfile(null)).toBeNull();
  });
});
