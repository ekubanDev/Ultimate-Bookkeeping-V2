import { useState } from "react";
import { Button } from "@ub/shared-ui";
import ProductGrid from "./ProductGrid.jsx";
import Cart from "./Cart.jsx";
import CheckoutModal from "./CheckoutModal.jsx";
import { useCart } from "./useCart.js";
import { useSubmitSale } from "./useSubmitSale.js";

// TODO: replace with a real product-catalog fetch once
// GET /api/v1/products exists (not yet in
// ultimate-bookkeeping-v2-api-contracts.md) — tracked as an open item for
// Kwame/Efua. Prices are NUMERIC(12,2) strings per CLAUDE.md's money rule,
// same shape a real catalog endpoint would return.
const DEMO_PRODUCTS = [
  { id: "prod-demo-water", name: "Sachet Water (bag)", unit_price: "5.00" },
  { id: "prod-demo-milo", name: "Milo 400g", unit_price: "45.00" },
  { id: "prod-demo-kalyppo", name: "Kalyppo Juice", unit_price: "8.50" },
  { id: "prod-demo-rice", name: "Rice 5kg", unit_price: "75.00" },
  { id: "prod-demo-oil", name: "Frytol Oil 1L", unit_price: "38.00" },
  { id: "prod-demo-soap", name: "Key Soap", unit_price: "12.00" },
];

// TODO: source from the logged-in cashier's outlet context once auth/outlet
// selection exists — out of scope for this pass (mirrors the same
// placeholder already used by ExpensesScreen/StockScreen).
const OUTLET_ID = "TODO-outlet-id";

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
  const cart = useCart();
  const { submitSale, status } = useSubmitSale();

  const handleConfirm = async ({ paymentMethod, discountAmount, taxAmount }) => {
    try {
      await submitSale({
        outletId: OUTLET_ID,
        lineItems: cart.lineItems.map((li) => ({
          product_id: li.product_id,
          quantity: li.quantity,
          unit_price: li.unit_price,
        })),
        paymentMethod,
        discountAmount,
        taxAmount,
      });
      // enqueue() resolving IS success from the cashier's perspective
      // (design doc §3.2) — the sale is durably queued even before it's
      // synced, so the cart clears and the modal closes here. Ongoing
      // sync/failure state after this point is SyncBanner's job, not
      // this screen's.
      cart.clear();
      setCheckoutOpen(false);
    } catch {
      // submitSale already set status to 'failed' and stored the error;
      // keep the modal open so CheckoutModal can render the failed state
      // and the cashier can retry without re-entering the whole cart.
    }
  };

  return (
    <section className="ub-pos-screen">
      <h1>POS</h1>
      <ProductGrid products={DEMO_PRODUCTS} onAddProduct={cart.addItem} />
      <Cart
        lineItems={cart.lineItems}
        total={cart.total}
        onSetQuantity={cart.setQuantity}
        onRemoveItem={cart.removeItem}
      />
      <Button
        disabled={cart.lineItems.length === 0}
        onClick={() => setCheckoutOpen(true)}
      >
        Checkout
      </Button>
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
