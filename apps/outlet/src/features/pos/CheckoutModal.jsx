import { useState } from "react";
import { Modal, Button } from "@ub/shared-ui";

/**
 * CheckoutModal — collects payment method and confirms the sale.
 *
 * Owns: checkout-step UI (payment method selection, confirm/cancel).
 * Does NOT own: cart contents (receives `total`/`lineItems` as props) or
 * the actual submission — calls `onConfirm(paymentMethod)`, which
 * PosScreen wires to useSubmitSale.submitSale.
 */
export default function CheckoutModal({
  isOpen,
  onClose,
  total = "0.00",
  onConfirm,
  status = "idle",
}) {
  const [paymentMethod, setPaymentMethod] = useState("cash");

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Checkout">
      <p>Total due: {total}</p>
      <label>
        Payment method
        <select
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
        >
          <option value="cash">Cash</option>
          <option value="mobile_money">Mobile Money</option>
          <option value="card">Card</option>
        </select>
      </label>
      <Button
        onClick={() => onConfirm?.(paymentMethod)}
        disabled={status === "queued"}
      >
        {status === "queued" ? "Recording..." : "Confirm sale"}
      </Button>
    </Modal>
  );
}
