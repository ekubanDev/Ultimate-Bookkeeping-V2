/**
 * ProductGrid — renders the tappable product catalog for the outlet.
 *
 * Owns: product tile layout/rendering, tap-to-add affordance.
 * Does NOT own: cart state (calls `onAddProduct`, delegating to useCart via
 * PosScreen) or fetching the product list (receives `products` as a prop —
 * a future useProducts hook or cached catalog owns that fetch).
 */
export default function ProductGrid({ products = [], onAddProduct }) {
  if (products.length === 0) {
    return <p className="ub-product-grid__empty">No products loaded yet.</p>;
  }

  return (
    <div className="ub-product-grid">
      {products.map((product) => (
        <button
          key={product.id}
          type="button"
          className="ub-product-grid__tile"
          onClick={() => onAddProduct?.(product)}
        >
          <span className="ub-product-grid__name">{product.name}</span>
          <span className="ub-product-grid__price">{product.unit_price}</span>
        </button>
      ))}
    </div>
  );
}
