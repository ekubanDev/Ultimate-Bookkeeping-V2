/**
 * Cart — renders the current sale's line items and running total.
 *
 * Owns: line-item list rendering, quantity +/- and remove controls (wired
 * to the callbacks passed down from useCart via PosScreen).
 * Does NOT own: cart math (useCart computes `total` and mutates line
 * items) or checkout submission (CheckoutModal + useSubmitSale own that).
 */
export default function Cart({
  lineItems = [],
  total = "0.00",
  onSetQuantity,
  onRemoveItem,
}) {
  return (
    <div className="ub-cart">
      {lineItems.length === 0 ? (
        <p className="ub-cart__empty">Cart is empty.</p>
      ) : (
        <ul className="ub-cart__list">
          {lineItems.map((item) => (
            <li key={item.product_id} className="ub-cart__line">
              <span className="ub-cart__line-name">{item.name}</span>
              <input
                type="number"
                min="0"
                value={item.quantity}
                onChange={(e) =>
                  onSetQuantity?.(item.product_id, Number(e.target.value))
                }
              />
              <span className="ub-cart__line-price">{item.unit_price}</span>
              <button
                type="button"
                onClick={() => onRemoveItem?.(item.product_id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ub-cart__total">Total: {total}</div>
    </div>
  );
}
