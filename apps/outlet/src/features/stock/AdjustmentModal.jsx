import { useEffect, useState } from "react";
import { Modal, Button, Input } from "@ub/shared-ui";

/**
 * AdjustmentModal — collects a delta and reason for a manual stock
 * adjustment.
 *
 * Owns: the adjustment form UI (delta input, reason select).
 * Does NOT own: stock level state (receives the target product/level as a
 * prop) or the actual submission — calls `onConfirm({ delta, reason })`,
 * which StockScreen wires to useSubmitAdjustment.submitAdjustment.
 */
export default function AdjustmentModal({
  isOpen,
  onClose,
  product,
  onConfirm,
  status = "idle",
}) {
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState("adjustment");

  // Reset form state when modal closes so it's blank for the next product.
  useEffect(() => {
    if (!isOpen) {
      setDelta(0);
      setReason("adjustment");
    }
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Adjust stock">
      {product ? (
        <p>{product.product_name ?? product.product_id}</p>
      ) : null}
      <Input
        label="Delta (negative to reduce, positive to add)"
        id="adjustment-delta"
        type="number"
        value={delta}
        onChange={(e) => setDelta(Number(e.target.value))}
      />
      <label htmlFor="adjustment-reason">Reason</label>
      <select
        id="adjustment-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      >
        <option value="adjustment">Adjustment</option>
        <option value="restock">Restock</option>
      </select>
      <Button
        onClick={() => onConfirm?.({ delta, reason })}
        disabled={status === "queued" || delta === 0}
      >
        {status === "queued" ? "Recording..." : "Confirm adjustment"}
      </Button>
    </Modal>
  );
}
