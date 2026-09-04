import { useState } from "react";
import { useAuth } from "../../auth/AuthContext.jsx";
import StockLevelList from "./StockLevelList.jsx";
import AdjustmentModal from "./AdjustmentModal.jsx";
import { useSubmitAdjustment } from "./useSubmitAdjustment.js";
import { useStockLevels } from "./useStockLevels.js";

/**
 * StockScreen — top-level stock screen.
 *
 * Owns: layout and screen-level state (which product's adjustment modal is
 * open, the current outlet_id — read from the signed-in manager's /me
 * profile, per api-contracts.md §1).
 * Does NOT own: fetching stock levels (delegates to useStockLevels) or
 * submission (delegates to useSubmitAdjustment).
 */
export default function StockScreen() {
  const { profile } = useAuth();
  const [adjustingProduct, setAdjustingProduct] = useState(null);
  const { submitAdjustment, status } = useSubmitAdjustment();
  const { levels, loading, error, refetch } = useStockLevels(profile?.outlet_id);

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

  const handleConfirm = async ({ delta, reason }) => {
    if (!adjustingProduct) return;
    try {
      await submitAdjustment({
        productId: adjustingProduct.product_id,
        outletId: profile.outlet_id,
        delta,
        reason,
      });
      // enqueue() resolving is durable success — close the modal and refresh
      // the displayed quantities so the manager sees the updated stock.
      setAdjustingProduct(null);
      refetch();
    } catch {
      // submitAdjustment set status to 'failed'; keep modal open so the
      // manager can see the failure state (status prop on AdjustmentModal).
    }
  };

  return (
    <section className="ub-stock-screen">
      <h1>Stock</h1>
      {loading && <p className="ub-stock-screen__loading">Loading stock levels...</p>}
      {error && (
        <p className="ub-stock-screen__error">
          Could not load stock levels. Check your connection and try again.
        </p>
      )}
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
