import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App.jsx";

// App wires onReconnect() once at startup and SyncBanner reads the queue
// snapshot — neither is this test's concern (component tests for those
// live in their own feature folders), so stub the whole package the same
// way PosScreen.test.jsx does.
const enqueueMock = vi.fn();
vi.mock("@ub/offline-queue", () => ({
  enqueue: (...args) => enqueueMock(...args),
  onReconnect: () => () => {},
  getQueueSnapshot: () =>
    Promise.resolve({
      counts: {
        queued: 0,
        syncing: 0,
        synced: 0,
        failed: 0,
        discarded: 0,
        blocked_identity_mismatch: 0,
      },
      entries: [],
    }),
  subscribe: () => () => {},
  // App.jsx calls this once at startup to prune stale synced/discarded
  // entries (see App.jsx's pruneStaleEntries effect) — not this test's
  // concern (offline-queue's own tests cover pruning behavior), so stub it.
  pruneStaleEntries: () => Promise.resolve({ prunedCount: 0 }),
}));

// App's rendering decision is entirely a function of useAuth()'s status —
// mock the auth context directly so each branch of the gate can be
// exercised without touching Firebase/api-client at all.
const useAuthMock = vi.fn();
vi.mock("./auth/AuthContext.jsx", () => ({
  useAuth: () => useAuthMock(),
}));

beforeEach(() => {
  useAuthMock.mockReset();
  enqueueMock.mockReset();
});

describe("App — auth status gate", () => {
  it("renders a loading splash while status is 'loading'", () => {
    useAuthMock.mockReturnValue({ status: "loading", profile: null, error: null });
    render(<App />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("renders an 'auth not configured' message when status is 'unconfigured'", () => {
    useAuthMock.mockReturnValue({ status: "unconfigured", profile: null, error: null });
    render(<App />);
    expect(screen.getByText(/auth not configured/i)).toBeTruthy();
  });

  it("renders the unprovisioned message when status is 'unprovisioned'", () => {
    useAuthMock.mockReturnValue({
      status: "unprovisioned",
      profile: null,
      error: "Your account isn't set up yet — ask your admin to set up your account.",
    });
    render(<App />);
    expect(screen.getByText(/ask your admin/i)).toBeTruthy();
  });

  it("renders LoginScreen when status is 'signed_out'", () => {
    useAuthMock.mockReturnValue({ status: "signed_out", profile: null, error: null, signIn: vi.fn() });
    render(<App />);
    expect(screen.getByRole("heading", { name: /^sign in$/i })).toBeTruthy();
  });

  it("renders the nav/screens when status is 'signed_in'", () => {
    useAuthMock.mockReturnValue({
      status: "signed_in",
      profile: { id: "user-1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Test Manager" },
      error: null,
    });
    render(<App />);
    // Default route redirects to /pos.
    expect(screen.getByRole("heading", { name: /^pos$/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /stock/i })).toBeTruthy();
  });
});
