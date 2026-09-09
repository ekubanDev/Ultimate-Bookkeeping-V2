import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onReconnect, pruneStaleEntries, reconcileStaleSyncing } from "@ub/offline-queue";
import { useAuth } from "./auth/AuthContext.jsx";
import LoginScreen from "./auth/LoginScreen.jsx";
import OutletNav from "./navigation/OutletNav.jsx";
import PosScreen from "./features/pos/PosScreen.jsx";
import SyncBanner from "./features/sync-status/SyncBanner.jsx";
import UpdatePrompt from "./pwa/UpdatePrompt.jsx";

// Stock/Expenses/Sync are route-split (see the ROUTE-SPLITTING NOTE below) —
// POS stays a static top-level import since it's the screen a cashier
// lands on, and must never depend on a lazy chunk fetch succeeding.
const StockScreen = lazy(() => import("./features/stock/StockScreen.jsx"));
const ExpensesScreen = lazy(() => import("./features/expenses/ExpensesScreen.jsx"));
// SyncResolutionScreen (Adjoa QA bug #2's fix — see that file) follows the
// same reasoning as Stock/Expenses below: its retry/discard actions route
// through @ub/offline-queue same as any offline-eligible write, and the SW
// precache covers this chunk exactly like the others once install completes.
const SyncResolutionScreen = lazy(() => import("./features/sync-status/SyncResolutionScreen.jsx"));

/**
 * App — top-level shell for the Outlet app.
 *
 * Owns: gating the whole app on auth status (splash while loading, the
 * login form while signed out, a plain message for the
 * unconfigured/unprovisioned states, the real nav/screens once signed in),
 * plus route wiring between the four screens (POS / Stock / Expenses /
 * Sync) and mounting the persistent SyncBanner + OutletNav chrome around
 * whichever screen is active, and initializing offline-queue's
 * onReconnect() listener once at startup.
 *
 * Does NOT own: any screen's internal state or API calls — those live in
 * each feature folder. Does NOT own: the offline-queue reconnect listener's
 * business logic — that belongs to /packages/offline-queue; App.jsx just
 * calls onReconnect() once so the 'online' -> flush() wiring is live for
 * the whole app session. Does NOT own: what "signed in" means — that's
 * AuthProvider's job (see src/auth/AuthContext.jsx); this component only
 * reads `status` and picks what to render. Does NOT own: service-worker
 * registration or the update-prompt state machine — see
 * src/pwa/UpdatePrompt.jsx; App.jsx just mounts it once, outside the auth
 * gate.
 *
 * ROUTE-SPLITTING NOTE (Kojo, 2026-09 — revised): StockScreen/ExpensesScreen
 * are now React.lazy-split. Previously (see git history on this file) they
 * were deliberately kept as static imports specifically because this repo
 * had no service worker: a lazily-loaded chunk that was never fetched
 * before the user went offline would fail to load exactly when they tried
 * to record a stock adjustment or expense offline. vite.config.js's
 * `workbox.globPatterns` now precaches every build output chunk — including
 * these two lazy chunks — at SW-install time, alongside the shell, so once
 * install completes they're served from Cache Storage offline exactly like
 * the eagerly-bundled code was before. That's what changed and why this is
 * safe now.
 *
 * Residual hole, reported rather than silently accepted: the very first
 * visit to this app, before the service worker has finished installing
 * (which requires fetching every precached file over the network — real
 * time on a "cheap Android device with intermittent connectivity"), has NO
 * offline protection yet for *anything*, split or not — a reload in that
 * narrow window fails exactly as it would with zero PWA support. This is
 * not specific to route-splitting: it's the same gap the app shell itself
 * has on a first cold visit. Splitting Stock/Expenses doesn't widen that
 * window or add a new one on top of it — once precache install succeeds
 * (same moment the shell itself becomes reload-safe), the split chunks are
 * exactly as safe as the shell. See the outlet build report in the task
 * writeup for the measured bundle-size effect of this split.
 */
export default function App() {
  const { status, error } = useAuth();

  // onReconnect() is wired regardless of auth status — a queued offline
  // write made before a token expired/refreshed should still get flushed
  // the moment connectivity returns; api-client's token provider (set by
  // AuthProvider) supplies a fresh token to each replayed request anyway.
  useEffect(() => onReconnect(), []);

  // Startup retention-pruning trigger (Nana's security-review finding — see
  // @ub/offline-queue's RETENTION_WINDOW_MS docstring): the other trigger,
  // "after every successful flush()", only fires once something has
  // actually been dispatched, so a session that opens the app without any
  // new sale/adjustment/expense wouldn't otherwise get a chance to prune
  // old synced/discarded history. One cheap IndexedDB scan at mount, not a
  // timer.
  useEffect(() => {
    pruneStaleEntries().catch(() => {});
  }, []);

  // Startup stale-'syncing' reconciliation trigger (Adjoa QA bug #3 — see
  // @ub/offline-queue's reconcileStaleSyncing() docstring for the full
  // rationale): also run automatically at the top of every flush(), but a
  // killed-and-relaunched app may sit offline for a while before anything
  // else triggers a flush(). Without this explicit call, an entry stranded
  // in 'syncing' by a crash would keep showing as "syncing…" the whole time
  // instead of being visibly returned to the normal queue the moment the
  // app comes back up.
  useEffect(() => {
    reconcileStaleSyncing().catch(() => {});
  }, []);

  if (status === "loading") {
    return (
      <>
        <UpdatePrompt />
        <main className="ub-app-splash">
          <p>Loading...</p>
        </main>
      </>
    );
  }

  if (status === "unconfigured") {
    return (
      <>
        <UpdatePrompt />
        <main className="ub-app-message">
          <h1>Auth not configured</h1>
          <p>
            This app doesn't have Firebase auth configured. Set the VITE_FIREBASE_* env vars
            (see apps/outlet/.env.example) and reload.
          </p>
        </main>
      </>
    );
  }

  if (status === "unprovisioned") {
    return (
      <>
        <UpdatePrompt />
        <main className="ub-app-message">
          <h1>Account not set up</h1>
          <p>{error}</p>
        </main>
      </>
    );
  }

  if (status === "signed_out") {
    return (
      <>
        <UpdatePrompt />
        <LoginScreen />
      </>
    );
  }

  // 'signed_in_degraded' (AuthContext.jsx's offline-relaunch lockout fix):
  // Firebase restored a session, /me couldn't be reached (network failure),
  // but we have a cached last-known-good profile for this device/user, so
  // the cashier keeps working — POS/Stock/Expenses all still queue into
  // offline-queue normally. This must never be silent, so it gets its own
  // visible banner (distinct from SyncBanner's per-item sync states) rather
  // than rendering identically to a normal 'signed_in' session.
  const isDegraded = status === "signed_in_degraded";

  return (
    <BrowserRouter>
      <UpdatePrompt />
      {isDegraded && (
        <div className="ub-app-degraded-banner" role="status">
          {error}
        </div>
      )}
      <SyncBanner />
      <main className="ub-app-content">
        <Suspense fallback={<p className="ub-app-route-loading">Loading…</p>}>
          <Routes>
            <Route path="/" element={<Navigate to="/pos" replace />} />
            <Route path="/pos" element={<PosScreen />} />
            <Route path="/stock" element={<StockScreen />} />
            <Route path="/expenses" element={<ExpensesScreen />} />
            <Route path="/sync" element={<SyncResolutionScreen />} />
          </Routes>
        </Suspense>
      </main>
      <OutletNav />
    </BrowserRouter>
  );
}
