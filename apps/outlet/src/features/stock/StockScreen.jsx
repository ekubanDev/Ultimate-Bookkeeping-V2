import { useState } from "react";
import StockLevelList from "./StockLevelList.jsx";
import AdjustmentModal from "./AdjustmentModal.jsx";
import { useSubmitAdjustment } from "./useSubmitAdjustment.js";

/**
 * StockScreen — top-level stock screen.
 *
 * Owns: layout and screen-level state (which product's adjustment modal is
 * open).
 * Does NOT own: fetching stock levels (TODO: useStockLevels, not in this
 * scaffold's file list yet) or submission (delegates to
 * useSubmitAdjustment).
 */
export default function StockScreen() {
  const [adjustingProduct, setAdjustingProduct] = useState(null);
  // TODO: replace with real GET /stock/levels fetch (out of scope for scaffold).
  const [levels] = useState([]);
  const { submitAdjustment, status } = useSubmitAdjustment();

  const handleConfirm = async (delta) => {
    if (!adjustingProduct) return;
    await submitAdjustment({
      productId: adjustingProduct.product_id,
      outletId: adjustingProduct.outlet_id,
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
