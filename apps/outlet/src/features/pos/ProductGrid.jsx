/**
 * ProductGrid — renders the tappable product catalog for the outlet.
 *
 * Owns: product tile layout/rendering, tap-to-add affordance.
 * Does NOT own: cart state (calls `onAddProduct`, delegating to useCart via
 * PosScreen) or fetching the product list (receives `products` as a prop —
 * a future useProducts hook or cached catalog owns that fetch).
 */
import { formatMoney } from "@ub/shared-ui";

import { describeStock, STOCK_UNKNOWN } from "./productStock.js";

export default function ProductGrid({
  products = [],
  onAddProduct,
  stockByProduct = null,
  hasStockData = false,
}) {
  if (products.length === 0) {
    return <p className="ub-product-grid__empty">No products loaded yet.</p>;
  }

  return (
    <div className="ub-product-grid">
      {products.map((product) => (
        <ProductTile
          key={product.id}
          product={product}
          stock={describeStock(product, stockByProduct, hasStockData)}
          onAddProduct={onAddProduct}
        />
      ))}
    </div>
  );
}

/**
 * One tile. Split out so the stock cue lives in one place rather than being
 * threaded through the map body.
 *
 * The stock line is omitted entirely when state is `unknown` — offline, that
 * is every product, and an empty space says "we don't know" far better than a
 * zero would.
 */
function ProductTile({ product, stock, onAddProduct }) {
  return (
    <button
      type="button"
      className={`ub-product-grid__tile ub-product-grid__tile--${stock.state}`}
      onClick={() => onAddProduct?.(product)}
    >
      <span className="ub-product-grid__name">{product.name}</span>
      {stock.state !== STOCK_UNKNOWN && stock.label && (
        <span className={`ub-product-grid__stock ub-product-grid__stock--${stock.state}`}>
          {stock.label}
        </span>
      )}
      <span className="ub-product-grid__price">{formatMoney(product.unit_price)}</span>
    </button>
  );
}
