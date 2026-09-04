import { Button } from "@ub/shared-ui";

/**
 * Cart — renders the current sale's line items and running total.
 *
 * Owns: line-item list rendering, quantity stepper (+/-) and remove
 * controls. Pure presentation — every state change is routed back up via
 * the `onSetQuantity`/`onRemoveItem` callbacks (wired to useCart's
 * setQuantity/removeItem via PosScreen); this component holds no state of
 * its own.
 * Does NOT own: cart math (useCart computes `total` and the line items via
 * cartReducer) or checkout submission (CheckoutModal + useSubmitSale own
 * that).
 *
 * `total` here is the running SUBTOTAL (pre-discount, pre-tax) — a preview
 * for the cashier while building the cart, not the final amount due. See
 * useCart's `total` doc comment: the server is the sole pricing authority,
 * and discount/tax are only entered at checkout (CheckoutModal).
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
              <span className="ub-cart__line-stepper">
                <Button
                  variant="secondary"
                  aria-label={`Decrease quantity of ${item.name}`}
                  onClick={() => onSetQuantity?.(item.product_id, item.quantity - 1)}
                >
                  −
                </Button>
                <span className="ub-cart__line-quantity">{item.quantity}</span>
                <Button
                  variant="secondary"
                  aria-label={`Increase quantity of ${item.name}`}
                  onClick={() => onSetQuantity?.(item.product_id, item.quantity + 1)}
                >
                  +
                </Button>
              </span>
              <span className="ub-cart__line-price">{item.unit_price}</span>
              <Button
                variant="secondary"
                onClick={() => onRemoveItem?.(item.product_id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="ub-cart__total">Subtotal: {total}</div>
    </div>
  );
}
