import { useState } from "react";
import ProductGrid from "./ProductGrid.jsx";
import Cart from "./Cart.jsx";
import CheckoutModal from "./CheckoutModal.jsx";
import { useCart } from "./useCart.js";
import { useSubmitSale } from "./useSubmitSale.js";

/**
 * PosScreen — top-level POS screen.
 *
 * Owns: layout and screen-level state (which modal is open, the current
 * outlet_id/context).
 * Does NOT own: cart math (delegates to useCart) or API calls (delegates
 * to useSubmitSale). Per ultimate-bookkeeping-v2-outlet-ui-plan.md §3.
 */
export default function PosScreen() {
  const [isCheckoutOpen, setCheckoutOpen] = useState(false);
  // TODO: replace with real product catalog fetch (out of scope for scaffold).
  const [products] = useState([]);
  const cart = useCart();
  const { submitSale, status } = useSubmitSale();

  const handleConfirm = async (paymentMethod) => {
    await submitSale({
      outletId: "TODO-outlet-id",
      lineItems: cart.lineItems.map((li) => ({
        product_id: li.product_id,
        quantity: li.quantity,
        unit_price: li.unit_price,
      })),
      paymentMethod,
    });
    cart.clear();
    setCheckoutOpen(false);
  };

  return (
    <section className="ub-pos-screen">
      <h1>POS</h1>
      <ProductGrid products={products} onAddProduct={cart.addItem} />
      <Cart
        lineItems={cart.lineItems}
        total={cart.total}
        onSetQuantity={cart.setQuantity}
        onRemoveItem={cart.removeItem}
      />
      <button
        type="button"
        disabled={cart.lineItems.length === 0}
        onClick={() => setCheckoutOpen(true)}
      >
        Checkout
      </button>
      <CheckoutModal
        isOpen={isCheckoutOpen}
        onClose={() => setCheckoutOpen(false)}
        total={cart.total}
        status={status}
        onConfirm={handleConfirm}
      />
    </section>
  );
}
