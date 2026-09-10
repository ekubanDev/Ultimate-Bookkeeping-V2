import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SyncBanner from "./SyncBanner.jsx";

// SyncBanner -> useSyncStatus -> @ub/offline-queue.getQueueSnapshot()/subscribe()
// is the only side-effecting boundary this test needs to cross.
let snapshot = { counts: {}, entries: [] };
vi.mock("@ub/offline-queue", () => ({
  getQueueSnapshot: () => Promise.resolve(snapshot),
  subscribe: () => () => {},
}));

function setSnapshot(counts, entries) {
  snapshot = { counts, entries };
}

const EMPTY_COUNTS = {
  queued: 0,
  syncing: 0,
  synced: 0,
  failed: 0,
  discarded: 0,
  blocked_identity_mismatch: 0,
};

beforeEach(() => {
  setSnapshot(EMPTY_COUNTS, []);
});

describe("SyncBanner", () => {
  it("renders nothing when the queue is empty", async () => {
    const { container } = render(<SyncBanner />);
    // give the async getQueueSnapshot() a tick to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
  });

  it("renders a quiet, calm marker (not the failed/blocked styling) for synced sales flagged price_variance_flagged", async () => {
    setSnapshot(
      { ...EMPTY_COUNTS, synced: 2 },
      [
        {
          client_id: "a",
          state: "synced",
          last_response: { price_variance_flagged: true },
        },
        {
          client_id: "b",
          state: "synced",
          last_response: { price_variance_flagged: false },
        },
      ]
    );

    render(<SyncBanner />);

    expect(await screen.findByText(/1 sale\(s\) flagged for admin price review/i)).toBeTruthy();
    // Never rendered as a failure/alarm.
    expect(screen.queryByText(/failed to sync/i)).toBeNull();
  });

  it("explains identity-blocked entries plainly, distinct from a generic failure", async () => {
    setSnapshot(
      { ...EMPTY_COUNTS, blocked_identity_mismatch: 3 },
      [
        { client_id: "a", state: "blocked_identity_mismatch" },
        { client_id: "b", state: "blocked_identity_mismatch" },
        { client_id: "c", state: "blocked_identity_mismatch" },
      ]
    );

    render(<SyncBanner />);

    expect(
      await screen.findByText(/3 item\(s\) recorded by another user — they must sign in to sync/i)
    ).toBeTruthy();
    expect(screen.queryByText(/failed to sync/i)).toBeNull();
  });

  it("can show the syncing count, the variance note, and the identity-blocked note together", async () => {
    setSnapshot(
      { ...EMPTY_COUNTS, queued: 1, synced: 1, blocked_identity_mismatch: 1 },
      [
        { client_id: "queued-1", state: "queued" },
        {
          client_id: "synced-1",
          state: "synced",
          last_response: { price_variance_flagged: true },
        },
        { client_id: "blocked-1", state: "blocked_identity_mismatch" },
      ]
    );

    render(<SyncBanner />);

    expect(await screen.findByText(/1 item\(s\) syncing/i)).toBeTruthy();
    expect(await screen.findByText(/1 sale\(s\) flagged for admin price review/i)).toBeTruthy();
    expect(await screen.findByText(/1 item\(s\) recorded by another user/i)).toBeTruthy();
  });

  it("still shows the existing failed-item state unchanged", async () => {
    setSnapshot(
      { ...EMPTY_COUNTS, failed: 2 },
      [
        { client_id: "a", state: "failed" },
        { client_id: "b", state: "failed" },
      ]
    );

    render(<SyncBanner />);

    expect(await screen.findByText(/2 item\(s\) failed to sync — resolve needed/i)).toBeTruthy();
  });
});
