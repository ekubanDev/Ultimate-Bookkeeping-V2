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

  it("maps any other /me failure back to 'signed_out' with the server's message", () => {
    const result = deriveAuthState({ ok: false, code: "SOME_OTHER_ERROR", message: "server exploded" });
    expect(result.status).toBe("signed_out");
    expect(result.profile).toBeNull();
    expect(result.error).toBe("server exploded");
  });

  it("falls back to a generic message when the failure has none", () => {
    const result = deriveAuthState({ ok: false });
    expect(result.status).toBe("signed_out");
    expect(result.error).toMatch(/could not load your account/i);
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
