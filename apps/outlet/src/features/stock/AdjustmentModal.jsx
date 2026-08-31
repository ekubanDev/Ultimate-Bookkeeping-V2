import { useState } from "react";
import { Modal, Button, Input } from "@ub/shared-ui";

/**
 * AdjustmentModal — collects a delta and reason for a manual stock
 * adjustment.
 *
 * Owns: the adjustment form UI (delta input, reason).
 * Does NOT own: stock level state (receives the target product/level as a
 * prop) or the actual submission — calls `onConfirm(delta)`, which
 * StockScreen wires to useSubmitAdjustment.submitAdjustment.
 */
export default function AdjustmentModal({
  isOpen,
  onClose,
  product,
  onConfirm,
  status = "idle",
}) {
  const [delta, setDelta] = useState(0);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Adjust stock">
      {product ? <p>{product.product_id}</p> : null}
      <Input
        label="Delta (negative to reduce, positive to add)"
        id="adjustment-delta"
        type="number"
        value={delta}
        onChange={(e) => setDelta(Number(e.target.value))}
      />
      <Button
        onClick={() => onConfirm?.(delta)}
        disabled={status === "queued" || delta === 0}
      >
        {status === "queued" ? "Recording..." : "Confirm adjustment"}
      </Button>
    </Modal>
  );
}
