import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onReconnect } from "@ub/offline-queue";
import { useAuth } from "./auth/AuthContext.jsx";
import LoginScreen from "./auth/LoginScreen.jsx";
import OutletNav from "./navigation/OutletNav.jsx";
import PosScreen from "./features/pos/PosScreen.jsx";
import StockScreen from "./features/stock/StockScreen.jsx";
import ExpensesScreen from "./features/expenses/ExpensesScreen.jsx";
import SyncBanner from "./features/sync-status/SyncBanner.jsx";

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
 * reads `status` and picks what to render.
 */
export default function App() {
  const { status, error } = useAuth();

  // onReconnect() is wired regardless of auth status — a queued offline
  // write made before a token expired/refreshed should still get flushed
  // the moment connectivity returns; api-client's token provider (set by
  // AuthProvider) supplies a fresh token to each replayed request anyway.
  useEffect(() => onReconnect(), []);

  if (status === "loading") {
    return (
      <main className="ub-app-splash">
        <p>Loading...</p>
      </main>
    );
  }

  if (status === "unconfigured") {
    return (
      <main className="ub-app-message">
        <h1>Auth not configured</h1>
        <p>
          This app doesn't have Firebase auth configured. Set the VITE_FIREBASE_* env vars
          (see apps/outlet/.env.example) and reload.
        </p>
      </main>
    );
  }

  if (status === "unprovisioned") {
    return (
      <main className="ub-app-message">
        <h1>Account not set up</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (status === "signed_out") {
    return <LoginScreen />;
  }

  return (
    <BrowserRouter>
      <SyncBanner />
      <main className="ub-app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/pos" replace />} />
          <Route path="/pos" element={<PosScreen />} />
          <Route path="/stock" element={<StockScreen />} />
          <Route path="/expenses" element={<ExpensesScreen />} />
        </Routes>
      </main>
      <OutletNav />
    </BrowserRouter>
  );
}
