import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import OutletNav from "./navigation/OutletNav.jsx";
import PosScreen from "./features/pos/PosScreen.jsx";
import StockScreen from "./features/stock/StockScreen.jsx";
import ExpensesScreen from "./features/expenses/ExpensesScreen.jsx";
import SyncBanner from "./features/sync-status/SyncBanner.jsx";

/**
 * App — top-level shell for the Outlet app.
 *
 * Owns: route wiring between the four screens (POS / Stock / Expenses /
 * Sync), and mounting the persistent SyncBanner + OutletNav chrome around
 * whichever screen is active.
 *
 * Does NOT own: any screen's internal state or API calls — those live in
 * each feature folder. Does NOT own: registering the offline-queue
 * reconnect listener's business logic — that belongs to
 * /packages/offline-queue, though App.jsx is where it gets initialized
 * once at startup (TODO, once offline-queue.onReconnect has a real body).
 */
export default function App() {
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
