import { useState } from "react";
import { useAuth } from "../../auth/AuthContext.jsx";
import StockLevelList from "./StockLevelList.jsx";
import AdjustmentModal from "./AdjustmentModal.jsx";
import { useSubmitAdjustment } from "./useSubmitAdjustment.js";

/**
 * StockScreen — top-level stock screen.
 *
 * Owns: layout and screen-level state (which product's adjustment modal is
 * open, the current outlet_id — read from the signed-in manager's /me
 * profile, per api-contracts.md §1).
 * Does NOT own: fetching stock levels (TODO: useStockLevels, not in this
 * scaffold's file list yet) or submission (delegates to
 * useSubmitAdjustment).
 */
export default function StockScreen() {
  const { profile } = useAuth();
  const [adjustingProduct, setAdjustingProduct] = useState(null);
  // TODO: replace with real GET /stock/levels fetch (out of scope for scaffold).
  const [levels] = useState([]);
  const { submitAdjustment, status } = useSubmitAdjustment();

  // Admin accounts have no outlet_id — this app is for outlet managers only
  // (the admin console at /apps/admin is where cross-outlet views live, per
  // CLAUDE.md's scope boundary). Surface a plain notice rather than ever
  // sending a null outlet_id to the backend.
  if (!profile?.outlet_id) {
    return (
      <section className="ub-stock-screen">
        <h1>Stock</h1>
        <p>This app is for outlet managers. Your account has no outlet assigned.</p>
      </section>
    );
  }

  const handleConfirm = async (delta) => {
    if (!adjustingProduct) return;
    await submitAdjustment({
      productId: adjustingProduct.product_id,
      outletId: profile.outlet_id,
      delta,
    });
    setAdjustingProduct(null);
  };

  return (
    <section className="ub-stock-screen">
      <h1>Stock</h1>
      <StockLevelList levels={levels} onAdjust={setAdjustingProduct} />
      <AdjustmentModal
        isOpen={Boolean(adjustingProduct)}
        onClose={() => setAdjustingProduct(null)}
        product={adjustingProduct}
        status={status}
        onConfirm={handleConfirm}
      />
    </section>
  );
}
