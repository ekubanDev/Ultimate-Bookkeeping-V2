import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onReconnect } from "@ub/offline-queue";
import OutletNav from "./navigation/OutletNav.jsx";
import PosScreen from "./features/pos/PosScreen.jsx";
import StockScreen from "./features/stock/StockScreen.jsx";
import ExpensesScreen from "./features/expenses/ExpensesScreen.jsx";
import SyncBanner from "./features/sync-status/SyncBanner.jsx";

/**
 * App — top-level shell for the Outlet app.
 *
 * Owns: route wiring between the four screens (POS / Stock / Expenses /
 * Sync), mounting the persistent SyncBanner + OutletNav chrome around
 * whichever screen is active, and initializing offline-queue's
 * onReconnect() listener once at startup.
 *
 * Does NOT own: any screen's internal state or API calls — those live in
 * each feature folder. Does NOT own: the offline-queue reconnect listener's
 * business logic — that belongs to /packages/offline-queue; App.jsx just
 * calls onReconnect() once so the 'online' -> flush() wiring is live for
 * the whole app session.
 */
export default function App() {
  useEffect(() => onReconnect(), []);

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
