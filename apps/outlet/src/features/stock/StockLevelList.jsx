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
 * Low-stock threshold: quantity <= min_stock, per-product, now that
 * GET /api/v1/stock/levels returns min_stock (api-contracts.md §3).
 * min_stock is nullable — null means "no threshold configured" for that
 * product, which must NOT be treated as 0 and must NOT flag as low stock.
 *
 * The cue is never colour-only (cheap Android hardware in variable
 * lighting + colour-blind users): the "--low" row class pairs with a
 * visible "Low stock" text badge carrying its own aria-label, so the
 * signal survives even if colour doesn't render/isn't perceived.
 */
export default function StockLevelList({ levels = [], onAdjust }) {
  if (levels.length === 0) {
    return <p className="ub-stock-list__empty">No stock levels loaded yet.</p>;
  }

  return (
    <ul className="ub-stock-list">
      {levels.map((level) => {
        const isLow =
          level.min_stock !== null &&
          level.min_stock !== undefined &&
          level.quantity <= level.min_stock;
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
            {isLow && (
              <span
                className="ub-stock-list__low-badge"
                role="status"
                aria-label={`Low stock: ${level.product_name}`}
              >
                Low stock
              </span>
            )}
            <button type="button" onClick={() => onAdjust?.(level)}>
              Adjust
            </button>
          </li>
        );
      })}
    </ul>
  );
}
