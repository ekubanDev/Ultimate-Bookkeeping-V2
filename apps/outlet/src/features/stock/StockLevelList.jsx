/**
 * StockLevelList — renders current on-hand quantities per product for this
 * outlet.
 *
 * Owns: list rendering, low-stock highlighting (against `min_stock`), and
 * the "adjust" tap affordance per row.
 * Does NOT own: fetching stock levels (receives `levels` as a prop — a
 * future useStockLevels hook calling GET /stock/levels owns that) or the
 * adjustment flow itself (opens AdjustmentModal via `onAdjust`).
 */
export default function StockLevelList({ levels = [], onAdjust }) {
  if (levels.length === 0) {
    return <p className="ub-stock-list__empty">No stock levels loaded yet.</p>;
  }

  return (
    <ul className="ub-stock-list">
      {levels.map((level) => (
        <li key={level.product_id} className="ub-stock-list__row">
          <span className="ub-stock-list__name">{level.product_id}</span>
          <span className="ub-stock-list__qty">{level.quantity}</span>
          <button type="button" onClick={() => onAdjust?.(level)}>
            Adjust
          </button>
        </li>
      ))}
    </ul>
  );
}
