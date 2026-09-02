/**
 * StockLevelList — renders current on-hand quantities per product for this
 * outlet.
 *
 * Owns: list rendering, low-stock highlighting, and the "adjust" tap
 * affordance per row.
 * Does NOT own: fetching stock levels (receives `levels` as a prop from
 * StockScreen/useStockLevels) or the adjustment flow itself (opens
 * AdjustmentModal via `onAdjust`).
 *
 * Low-stock threshold: quantity <= 0. Ama to confirm final threshold; using
 * 0 as the conservative fallback (CLAUDE.md constraint: flag design decisions
 * for Ama's product input).
 */
export default function StockLevelList({ levels = [], onAdjust }) {
  if (levels.length === 0) {
    return <p className="ub-stock-list__empty">No stock levels loaded yet.</p>;
  }

  return (
    <ul className="ub-stock-list">
      {levels.map((level) => {
        const isLow = level.quantity <= 0;
        return (
          <li
            key={level.product_id}
            className={`ub-stock-list__row${isLow ? " ub-stock-list__row--low" : ""}`}
          >
            <span className="ub-stock-list__name">{level.product_name}</span>
            {level.sku ? (
              <span className="ub-stock-list__sku">{level.sku}</span>
            ) : null}
            <span className="ub-stock-list__qty">{level.quantity}</span>
            <button type="button" onClick={() => onAdjust?.(level)}>
              Adjust
            </button>
          </li>
        );
      })}
    </ul>
  );
}
