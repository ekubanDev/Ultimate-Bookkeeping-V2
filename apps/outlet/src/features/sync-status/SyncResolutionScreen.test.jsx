import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SyncResolutionScreen from "./SyncResolutionScreen.jsx";

// Adjoa QA bug #2: SyncBanner rendered "N item(s) failed to sync — resolve
// needed" but nothing ever called retryEntry()/discardEntry(). This suite
// exercises the screen that now does — mocking @ub/offline-queue at the
// same boundary SyncBanner.test.jsx does (useSyncStatus -> getQueueSnapshot
// / subscribe), plus the two actions this screen adds.
let snapshot = { counts: {}, entries: [] };
const retryEntryMock = vi.fn();
const discardEntryMock = vi.fn();

vi.mock("@ub/offline-queue", () => ({
  getQueueSnapshot: () => Promise.resolve(snapshot),
  subscribe: () => () => {},
  retryEntry: (...args) => retryEntryMock(...args),
  discardEntry: (...args) => discardEntryMock(...args),
}));

function setSnapshot(entries) {
  const counts = {
    queued: 0,
    syncing: 0,
    synced: 0,
    failed: entries.filter((e) => e.state === "failed").length,
    discarded: 0,
    blocked_identity_mismatch: 0,
  };
  snapshot = { counts, entries };
}

beforeEach(() => {
  setSnapshot([]);
  retryEntryMock.mockReset().mockResolvedValue({});
  discardEntryMock.mockReset().mockResolvedValue({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("SyncResolutionScreen", () => {
  it("shows a calm empty state when nothing has failed", async () => {
    render(<SyncResolutionScreen />);
    expect(await screen.findByText(/nothing needs your attention/i)).toBeTruthy();
  });

  it("lists each failed entry with its stored error message and code", async () => {
    setSnapshot([
      {
        client_id: "a",
        type: "sale",
        state: "failed",
        last_error: { code: "INSUFFICIENT_STOCK", message: "Not enough stock for this item.", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);

    expect(await screen.findByText(/not enough stock for this item/i)).toBeTruthy();
    expect(screen.getByText(/INSUFFICIENT_STOCK/i)).toBeTruthy();
    expect(screen.getByText(/^Sale$/i)).toBeTruthy();
  });

  it("Retry calls offline-queue.retryEntry with the SAME client_id — never a new one", async () => {
    setSnapshot([
      {
        client_id: "sale-123",
        type: "sale",
        state: "failed",
        last_error: { code: "PRODUCT_NOT_FOUND", message: "This product no longer exists.", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const retryButton = await screen.findByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);

    await vi.waitFor(() => expect(retryEntryMock).toHaveBeenCalledWith("sale-123"));
  });

  it("Discard asks for confirmation, then calls offline-queue.discardEntry", async () => {
    setSnapshot([
      {
        client_id: "sale-456",
        type: "stock_adjustment",
        state: "failed",
        last_error: { code: "PRODUCT_NOT_FOUND", message: "This product no longer exists.", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const discardButton = await screen.findByRole("button", { name: /discard/i });
    fireEvent.click(discardButton);

    expect(window.confirm).toHaveBeenCalled();
    await vi.waitFor(() => expect(discardEntryMock).toHaveBeenCalledWith("sale-456"));
  });

  it("Discard does nothing if the user cancels the confirmation", async () => {
    window.confirm.mockReturnValue(false);
    setSnapshot([
      {
        client_id: "sale-789",
        type: "expense",
        state: "failed",
        last_error: { code: "X", message: "rejected", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const discardButton = await screen.findByRole("button", { name: /discard/i });
    fireEvent.click(discardButton);

    expect(discardEntryMock).not.toHaveBeenCalled();
  });

  it("surfaces a plain error if retryEntry itself rejects, without crashing", async () => {
    retryEntryMock.mockRejectedValue(new Error("still offline"));
    setSnapshot([
      {
        client_id: "sale-999",
        type: "sale",
        state: "failed",
        last_error: { code: "X", message: "rejected", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const retryButton = await screen.findByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);

    expect(await screen.findByText(/still offline/i)).toBeTruthy();
  });

  it("falls back to a generic explanation when an entry has no stored last_error", async () => {
    setSnapshot([{ client_id: "a", type: "sale", state: "failed", last_error: null }]);
    render(<SyncResolutionScreen />);
    expect(await screen.findByText(/rejected and needs your attention/i)).toBeTruthy();
  });

  it("says plainly that editing before retry isn't supported yet", async () => {
    setSnapshot([
      { client_id: "a", type: "sale", state: "failed", last_error: { code: "X", message: "x", retryable: false } },
    ]);
    render(<SyncResolutionScreen />);
    expect(await screen.findByText(/editing an entry's details before retrying isn't supported yet/i)).toBeTruthy();
  });
});
