import { describe, expect, it } from "vitest";
import { ApiClientError } from "@ub/api-client";
import { deriveAuthState, meResultFromError } from "./AuthContext.jsx";

describe("deriveAuthState", () => {
  it("maps a successful /me result to 'signed_in' with the profile attached", () => {
    const profile = { id: "u1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Ama" };
    expect(deriveAuthState({ ok: true, profile })).toEqual({
      status: "signed_in",
      profile,
      error: null,
    });
  });

  it("maps USER_NOT_PROVISIONED to 'unprovisioned' with a human-readable message", () => {
    const result = deriveAuthState({ ok: false, code: "USER_NOT_PROVISIONED", message: "nope" });
    expect(result.status).toBe("unprovisioned");
    expect(result.profile).toBeNull();
    expect(result.error).toMatch(/ask your admin/i);
  });

  it("maps any other CONFIRMED /me rejection (has a code — a real HTTP response) back to 'signed_out' with the server's message, even if a cached profile exists", () => {
    const cachedProfile = { id: "u1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Ama" };
    const result = deriveAuthState(
      { ok: false, code: "SOME_OTHER_ERROR", message: "server exploded" },
      cachedProfile
    );
    expect(result.status).toBe("signed_out");
    expect(result.profile).toBeNull();
    expect(result.error).toBe("server exploded");
  });

  it("falls back to a generic message when the failure has none and there is no cached profile", () => {
    const result = deriveAuthState({ ok: false });
    expect(result.status).toBe("signed_out");
    expect(result.error).toMatch(/could not load your account/i);
  });

  // --- Offline-relaunch lockout fix (Adjoa QA bug #1) ---
  //
  // Regression coverage: this SUITE used to assert that "any other /me
  // failure" (which, before the fix, included plain network errors with no
  // `code` at all) maps to 'signed_out'. That assertion was protecting the
  // bug — a legitimately signed-in cashier, relaunching the app while
  // offline (routine on this hardware: crash/force-quit/low-memory kill),
  // got dropped at a LoginScreen they also couldn't use offline. The cases
  // below replace it: a network-failure-shaped result (no `code` — see
  // meResultFromError) degrades into 'signed_in_degraded' when a cached
  // profile is available, and only falls back to 'signed_out' when there's
  // truly nothing to fall back on (e.g. this device has never successfully
  // reached /me for this account before).
  it("degrades to 'signed_in_degraded' on a network-failure-shaped /me result when a cached profile is available", () => {
    const cachedProfile = { id: "u1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Ama" };
    const result = deriveAuthState({ ok: false, message: "Network error" }, cachedProfile);
    expect(result.status).toBe("signed_in_degraded");
    expect(result.profile).toEqual(cachedProfile);
    expect(result.error).toMatch(/offline/i);
  });

  it("falls back to 'signed_out' on a network-failure-shaped /me result with no cached profile", () => {
    const result = deriveAuthState({ ok: false, message: "Network error" }, null);
    expect(result.status).toBe("signed_out");
    expect(result.profile).toBeNull();
  });

  it("USER_NOT_PROVISIONED stays 'unprovisioned' even if a cached profile exists — a confirmed rejection is never overridden by a cache", () => {
    const cachedProfile = { id: "u1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Ama" };
    const result = deriveAuthState(
      { ok: false, code: "USER_NOT_PROVISIONED", message: "nope" },
      cachedProfile
    );
    expect(result.status).toBe("unprovisioned");
    expect(result.profile).toBeNull();
  });
});

describe("meResultFromError", () => {
  it("normalizes an ApiClientError into {ok:false, code, message}", () => {
    const err = new ApiClientError({ code: "USER_NOT_PROVISIONED", message: "not set up", retryable: false }, 403);
    expect(meResultFromError(err)).toEqual({ ok: false, code: "USER_NOT_PROVISIONED", message: "not set up" });
  });

  it("normalizes a plain network/JS error into {ok:false, message}, no code", () => {
    expect(meResultFromError(new Error("network down"))).toEqual({ ok: false, message: "network down" });
  });

  it("survives a non-Error thrown value without crashing", () => {
    expect(meResultFromError("boom")).toEqual({ ok: false, message: "Network error" });
  });
});
