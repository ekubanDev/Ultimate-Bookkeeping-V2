import { useMemo, useState } from "react";
import { Button } from "@ub/shared-ui";
import { useAuth } from "../../auth/AuthContext.jsx";
import ProductGrid from "./ProductGrid.jsx";
import Cart from "./Cart.jsx";
import CheckoutModal from "./CheckoutModal.jsx";
import { useCart } from "./useCart.js";
import { useSubmitSale } from "./useSubmitSale.js";
import { useProducts } from "./useProducts.js";
import { filterProducts } from "./filterProducts.js";
import { useStockLevels } from "../stock/useStockLevels.js";
import {
  indexStockLevels,
  describeStock,
  shouldWarnBeforeSelling,
  warningFor,
} from "./productStock.js";

/**
 * PosScreen — top-level POS screen.
 *
 * Owns: layout and screen-level state (which modal is open, the current
 * outlet_id/context — read from the signed-in manager's /me profile, per
 * api-contracts.md §1: the backend ignores any client-supplied outlet_id
 * for managers, so this always sends what /me said).
 * Does NOT own: cart math (delegates to useCart) or API calls (delegates
 * to useSubmitSale). Per ultimate-bookkeeping-v2-outlet-ui-plan.md §3.
 */
export default function PosScreen() {
  const { profile } = useAuth();
  const [isCheckoutOpen, setCheckoutOpen] = useState(false);
  const [search, setSearch] = useState("");
  const cart = useCart();
  const { submitSale, status, reset: resetSubmit } = useSubmitSale();
  const { products, loading, error } = useProducts(profile?.outlet_id);
  const visibleProducts = useMemo(
    () => filterProducts(products, search),
    [products, search]
  );

  // Stock is fetched LIVE and never cached (the service worker routes
  // /stock/levels NetworkOnly on purpose). Offline this fails, `levels` stays
  // empty and every product reads as `unknown` — which is exactly right: the
  // POS then behaves as it did before stock existed here, rather than showing
  // a confidently wrong number. See the runbook: "a wrong stock number is
  // worse than no number".
  const { levels, error: stockError } = useStockLevels(profile?.outlet_id);
  const hasStockData = !stockError && Array.isArray(levels) && levels.length > 0;
  const stockByProduct = useMemo(() => indexStockLevels(levels), [levels]);

  // Set when the cashier taps something sold out or never stocked; cleared by
  // confirming or cancelling. Holds the product so confirming can still add it.
  const [pendingProduct, setPendingProduct] = useState(null);

  // Admin accounts have no outlet_id — this app is for outlet managers only
  // (the admin console at /apps/admin is where cross-outlet views live, per
  // CLAUDE.md's scope boundary). Surface a plain notice rather than ever
  // sending a null outlet_id to the backend.
  if (!profile?.outlet_id) {
    return (
      <section className="ub-pos-screen">
        <h1>POS</h1>
        <p>This app is for outlet managers. Your account has no outlet assigned.</p>
      </section>
    );
  }

  // Warn, never block. A stale or missing count must not refuse real money —
  // the shop may well have stock the books do not know about. The point is
  // that the cashier decides knowingly, instead of discovering hours later
  // that the sale could not sync.
  const handleAddProduct = (product) => {
    const stock = describeStock(product, stockByProduct, hasStockData);
    if (shouldWarnBeforeSelling(stock.state)) {
      setPendingProduct({ product, message: warningFor(stock.state, product.name) });
      return;
    }
    cart.addItem(product);
  };

  const handleConfirm = async ({ paymentMethod, discountType, discountValue, taxAmount }) => {
    try {
      await submitSale({
        outletId: profile.outlet_id,
        lineItems: cart.lineItems.map((li) => ({
          product_id: li.product_id,
          quantity: li.quantity,
          // Catalog-only: every line item is seeded from the real product
          // catalog (useProducts), never hand-typed by the cashier. Renamed
          // from `unit_price` to `submitted_unit_price` per the new
          // contract — persisted verbatim server-side; the server (not
          // this client) decides whether it matches the live catalog price
          // closely enough (price_variance_flagged).
          submitted_unit_price: li.unit_price,
        })),
        paymentMethod,
        discountType,
        discountValue,
        taxAmount,
      });
      // enqueue() resolving IS success from the cashier's perspective
      // (design doc §3.2) — the sale is durably queued even before it's
      // synced, so the cart clears and the modal closes here. Ongoing
      // sync/failure state after this point is SyncBanner's job, not
      // this screen's.
      //
      // Design note on `price_variance_flagged`: it's an admin-review
      // signal, not a till-side error — deliberately NOT surfaced here.
      // `enqueue()` resolves as soon as the intent is durably queued
      // (offline-first, per design doc §3.2), before the POST — and even
      // once synced, it's a quiet marker in SyncBanner (sync-status
      // feature), never a blocking/alarming state on this screen. See
      // packages/offline-queue's QueueEntry.last_response +
      // apps/outlet/src/features/sync-status/SyncBanner.jsx.
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
      {loading && <p className="ub-pos-screen__loading">Loading products...</p>}
      {error && (
        <p className="ub-pos-screen__error">
          Could not load products. Check your connection and try again.
        </p>
      )}
      {!loading && !error && products.length === 0 && (
        <p className="ub-pos-screen__empty">
          No products yet. Add products to this outlet's catalog to start selling.
        </p>
      )}
      {!loading && !error && products.length > 0 && (
        <>
          <div className="ub-pos-screen__search">
            <label className="ub-visually-hidden" htmlFor="ub-product-search">
              Search products
            </label>
            <input
              id="ub-product-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search products"
              autoComplete="off"
              // Not autoFocus: on a phone that opens the keyboard over the
              // grid every time the POS screen mounts, which is the wrong
              // default when most sales start by tapping a familiar product.
            />
            {search.trim() !== "" && (
              <p className="ub-pos-screen__search-count" role="status">
                {visibleProducts.length} of {products.length} products
              </p>
            )}
          </div>
          {visibleProducts.length === 0 ? (
            <p className="ub-pos-screen__empty">
              No products match &ldquo;{search.trim()}&rdquo;.
            </p>
          ) : (
            <ProductGrid
              products={visibleProducts}
              onAddProduct={handleAddProduct}
              stockByProduct={stockByProduct}
              hasStockData={hasStockData}
            />
          )}
        </>
      )}
      {pendingProduct && (
        <div
          className="ub-pos-screen__stock-warning"
          role="alertdialog"
          aria-label="Confirm selling an item that is not in stock"
        >
          <p>{pendingProduct.message}</p>
          <div className="ub-pos-screen__stock-warning-actions">
            <Button
              variant="danger"
              onClick={() => {
                cart.addItem(pendingProduct.product);
                setPendingProduct(null);
              }}
            >
              Sell anyway
            </Button>
            <Button variant="secondary" onClick={() => setPendingProduct(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <Cart
        lineItems={cart.lineItems}
        total={cart.total}
        onSetQuantity={cart.setQuantity}
        onRemoveItem={cart.removeItem}
      />
      <Button
        disabled={cart.lineItems.length === 0}
        onClick={() => {
          // Clear any terminal state from the PREVIOUS sale before opening.
          // Without this a stale 'failed' banner would greet the cashier at
          // the start of an unrelated sale.
          resetSubmit();
          setCheckoutOpen(true);
        }}
      >
        Checkout
      </Button>
      <CheckoutModal
        isOpen={isCheckoutOpen}
        onClose={() => setCheckoutOpen(false)}
        subtotal={cart.total}
        status={status}
        onConfirm={handleConfirm}
      />
    </section>
  );
}
