import { NavLink } from "react-router-dom";

/**
 * OutletNav — bottom navigation bar: POS / Stock / Expenses / Sync.
 *
 * Owns: route links and the visual "active tab" state.
 * Does NOT own: sync status content (delegates to SyncBanner, rendered
 * separately in App.jsx) or any screen's data.
 */
export default function OutletNav() {
  return (
    <nav className="ub-outlet-nav">
      <NavLink to="/pos" className="ub-outlet-nav__item">
        POS
      </NavLink>
      <NavLink to="/stock" className="ub-outlet-nav__item">
        Stock
      </NavLink>
      <NavLink to="/expenses" className="ub-outlet-nav__item">
        Expenses
      </NavLink>
    </nav>
  );
}
