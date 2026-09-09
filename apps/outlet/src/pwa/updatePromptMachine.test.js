import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reduceUpdatePrompt } from "./updatePromptMachine.js";

describe("updatePromptMachine", () => {
  it("starts idle", () => {
    expect(INITIAL_STATE).toBe("idle");
  });

  describe("OFFLINE_READY", () => {
    it("moves idle -> offline-ready", () => {
      expect(reduceUpdatePrompt("idle", { type: "OFFLINE_READY" })).toBe("offline-ready");
    });

    it("does not interrupt an update prompt already showing", () => {
      expect(reduceUpdatePrompt("update-available", { type: "OFFLINE_READY" })).toBe(
        "update-available"
      );
    });

    it("is a no-op once already offline-ready", () => {
      expect(reduceUpdatePrompt("offline-ready", { type: "OFFLINE_READY" })).toBe(
        "offline-ready"
      );
    });

    it("is a no-op while reloading", () => {
      expect(reduceUpdatePrompt("reloading", { type: "OFFLINE_READY" })).toBe("reloading");
    });
  });

  describe("NEED_REFRESH", () => {
    it("always wins from idle", () => {
      expect(reduceUpdatePrompt("idle", { type: "NEED_REFRESH" })).toBe("update-available");
    });

    it("always wins from offline-ready — an update is more important than a stale offline-ready notice", () => {
      expect(reduceUpdatePrompt("offline-ready", { type: "NEED_REFRESH" })).toBe(
        "update-available"
      );
    });

    it("is idempotent from update-available", () => {
      expect(reduceUpdatePrompt("update-available", { type: "NEED_REFRESH" })).toBe(
        "update-available"
      );
    });
  });

  describe("DISMISS", () => {
    it("clears offline-ready back to idle", () => {
      expect(reduceUpdatePrompt("offline-ready", { type: "DISMISS" })).toBe("idle");
    });

    it("clears update-available back to idle", () => {
      expect(reduceUpdatePrompt("update-available", { type: "DISMISS" })).toBe("idle");
    });

    it("is a no-op from idle", () => {
      expect(reduceUpdatePrompt("idle", { type: "DISMISS" })).toBe("idle");
    });

    it("is a no-op from reloading — a reload in flight can't be dismissed", () => {
      expect(reduceUpdatePrompt("reloading", { type: "DISMISS" })).toBe("reloading");
    });
  });

  describe("CONFIRM_RELOAD", () => {
    it("moves update-available -> reloading", () => {
      expect(reduceUpdatePrompt("update-available", { type: "CONFIRM_RELOAD" })).toBe(
        "reloading"
      );
    });

    it("is a no-op from idle (nothing waiting to confirm)", () => {
      expect(reduceUpdatePrompt("idle", { type: "CONFIRM_RELOAD" })).toBe("idle");
    });

    it("is a no-op from offline-ready (no update waiting yet)", () => {
      expect(reduceUpdatePrompt("offline-ready", { type: "CONFIRM_RELOAD" })).toBe(
        "offline-ready"
      );
    });

    it("is a no-op once already reloading", () => {
      expect(reduceUpdatePrompt("reloading", { type: "CONFIRM_RELOAD" })).toBe("reloading");
    });
  });

  it("ignores unknown event types, returning state unchanged", () => {
    expect(reduceUpdatePrompt("update-available", { type: "SOMETHING_ELSE" })).toBe(
      "update-available"
    );
  });

  it("supports a realistic full lifecycle: install -> offline-ready -> new deploy -> confirm -> reload", () => {
    let state = INITIAL_STATE;
    state = reduceUpdatePrompt(state, { type: "OFFLINE_READY" });
    expect(state).toBe("offline-ready");

    state = reduceUpdatePrompt(state, { type: "DISMISS" });
    expect(state).toBe("idle");

    state = reduceUpdatePrompt(state, { type: "NEED_REFRESH" });
    expect(state).toBe("update-available");

    state = reduceUpdatePrompt(state, { type: "CONFIRM_RELOAD" });
    expect(state).toBe("reloading");
  });

  it("supports dismissing an update prompt without losing the pending update (stays dismissable state, not re-triggered by this reducer alone)", () => {
    let state = "update-available";
    state = reduceUpdatePrompt(state, { type: "DISMISS" });
    expect(state).toBe("idle");
    // A dismissed update isn't re-surfaced by the reducer itself — it's
    // UpdatePrompt.jsx's job to decide whether to re-dispatch NEED_REFRESH
    // (it doesn't, by design — see that file's docstring on why dismiss is
    // a one-way "later" and not a nagging re-prompt).
  });
});
