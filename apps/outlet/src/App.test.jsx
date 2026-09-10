import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App.jsx";

// App wires onReconnect() once at startup and SyncBanner reads the queue
// snapshot — neither is this test's concern (component tests for those
// live in their own feature folders), so stub the whole package the same
// way PosScreen.test.jsx does.
const enqueueMock = vi.fn();
vi.mock("@ub/offline-queue", () => ({
  enqueue: (...args) => enqueueMock(...args),
  // useSubmitSale imports this to distinguish a full-disk enqueue() failure
  // from every other failure mode (Adjoa QA #6) — stub it as a real class so
  // `instanceof` checks work the same as against the real export.
  QuotaExceededStorageError: class QuotaExceededStorageError extends Error {},
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
  // App.jsx also calls this once at startup to un-strand any 'syncing'
  // entries left behind by a crash (Adjoa QA bug #3) — same reasoning as
  // pruneStaleEntries above, covered by offline-queue's own tests.
  reconcileStaleSyncing: () => Promise.resolve(),
}));

// App's rendering decision is entirely a function of useAuth()'s status —
// mock the auth context directly so each branch of the gate can be
// exercised without touching Firebase/api-client at all.
const useAuthMock = vi.fn();
vi.mock("./auth/AuthContext.jsx", () => ({
  useAuth: () => useAuthMock(),
}));

// UpdatePrompt.jsx registers the service worker via
// `virtual:pwa-register/react` — a build-time virtual module supplied by
// vite-plugin-pwa's Vite plugin, which vitest's config deliberately does
// NOT install (see vite.config.js's SERVICE WORKER note and
// updatePromptMachine.test.js/apiCacheRoutes.test.js for where that logic
// *is* covered). Stub the component itself here, the same way
// @ub/offline-queue and AuthContext are stubbed above, so this file keeps
// testing only what it owns: the auth-status gate.
vi.mock("./pwa/UpdatePrompt.jsx", () => ({
  default: () => null,
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
    // The resolve-failed-entries flow (Adjoa QA bug #2 fix — see
    // SyncResolutionScreen.jsx) is reachable from the bottom nav.
    expect(screen.getByRole("link", { name: /sync/i })).toBeTruthy();
  });

  // react-router-dom v6 -> v7 migration (Yaw's audit — housekeeping, no
  // reachable exploit in how this app uses the library: only static
  // routes, no SSR, no user-controlled redirect targets). This is the
  // "every route still works" verification the migration asked for: click
  // through all four bottom-nav destinations (Stock/Expenses/Sync are
  // React.lazy-split — see App.jsx's ROUTE-SPLITTING NOTE — so each needs
  // an await for its chunk + Suspense fallback to resolve) and confirm
  // BrowserRouter/Routes/Route/Navigate/NavLink still wire up correctly
  // under v7.
  it("navigates to every route (POS, Stock, Expenses, Sync) via the bottom nav", async () => {
    useAuthMock.mockReturnValue({
      status: "signed_in",
      profile: { id: "user-1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Test Manager" },
      error: null,
    });
    render(<App />);

    // Default route ("/") -> <Navigate to="/pos" replace /> -> /pos.
    expect(screen.getByRole("heading", { name: /^pos$/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: /^stock$/i }));
    expect(await screen.findByRole("heading", { name: /^stock$/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: /^expenses$/i }));
    expect(await screen.findByRole("heading", { name: /^expenses$/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: /^sync$/i }));
    expect(await screen.findByRole("heading", { name: /^sync$/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: /^pos$/i }));
    expect(await screen.findByRole("heading", { name: /^pos$/i })).toBeTruthy();
  });

  // Offline-relaunch lockout fix (Adjoa QA bug #1, AuthContext.jsx): the app
  // must keep working — not silently pretend to be fully normal — when
  // booted from a cached profile because /me couldn't be reached.
  it("renders the nav/screens AND a visible degraded-mode banner when status is 'signed_in_degraded'", () => {
    useAuthMock.mockReturnValue({
      status: "signed_in_degraded",
      profile: { id: "user-1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Test Manager" },
      error: "You're offline — working from your last signed-in account details. Some info may be out of date until you reconnect.",
    });
    render(<App />);
    // The cashier can still work — the app renders normally, not a splash/lockout.
    expect(screen.getByRole("heading", { name: /^pos$/i })).toBeTruthy();
    // But it's never silent about the degraded state.
    expect(screen.getByText(/last signed-in account details/i)).toBeTruthy();
  });
});
