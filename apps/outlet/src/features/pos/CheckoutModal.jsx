import { useEffect, useState } from "react";
import { Modal, Button, Input } from "@ub/shared-ui";

/** NUMERIC(12,2)-shaped string, e.g. "0.00" or "12.50". No parseFloat — this is a format check only. */
const MONEY_RE = /^\d+\.\d{2}$/;

function isValidMoneyString(value) {
  return typeof value === "string" && MONEY_RE.test(value);
}

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "mobile_money", label: "Mobile Money" },
  { value: "card", label: "Card" },
];

/**
 * CheckoutModal — collects payment method, optional discount/tax, and
 * confirms the sale.
 *
 * Owns: checkout-step UI (payment method selection, discount/tax entry
 * with 2-dp string validation, confirm/cancel, rendering the `failed`
 * status per useSubmitSale's status mapping).
 * Does NOT own: cart contents (receives `total` as a prop) or the actual
 * submission — calls `onConfirm({ paymentMethod, discountAmount, taxAmount })`,
 * which PosScreen wires to useSubmitSale.submitSale.
 */
export default function CheckoutModal({
  isOpen,
  onClose,
  total = "0.00",
  onConfirm,
  status = "idle",
}) {
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [discountAmount, setDiscountAmount] = useState("0.00");
  const [taxAmount, setTaxAmount] = useState("0.00");

  // Fresh checkout inputs every time the modal opens — CheckoutModal stays
  // mounted across opens/closes (PosScreen always renders it), so this
  // clears out whatever was typed on a prior, possibly-failed, attempt.
  useEffect(() => {
    if (isOpen) {
      setPaymentMethod("cash");
      setDiscountAmount("0.00");
      setTaxAmount("0.00");
    }
  }, [isOpen]);

  const discountValid = isValidMoneyString(discountAmount);
  const taxValid = isValidMoneyString(taxAmount);
  const canConfirm = discountValid && taxValid && status !== "queued";

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm?.({ paymentMethod, discountAmount, taxAmount });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Checkout">
      <p>Total due: {total}</p>
      <label className="ub-checkout-modal__payment-method">
        Payment method
        <select
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
        >
          {PAYMENT_METHODS.map((method) => (
            <option key={method.value} value={method.value}>
              {method.label}
            </option>
          ))}
        </select>
      </label>
      <Input
        label="Discount"
        id="checkout-discount"
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        value={discountAmount}
        onChange={(e) => setDiscountAmount(e.target.value)}
      />
      {!discountValid ? (
        <p className="ub-checkout-modal__field-error" role="alert">
          Discount must be a NUMERIC(12,2) amount, e.g. "0.00".
        </p>
      ) : null}
      <Input
        label="Tax"
        id="checkout-tax"
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        value={taxAmount}
        onChange={(e) => setTaxAmount(e.target.value)}
      />
      {!taxValid ? (
        <p className="ub-checkout-modal__field-error" role="alert">
          Tax must be a NUMERIC(12,2) amount, e.g. "0.00".
        </p>
      ) : null}
      {status === "failed" ? (
        <p className="ub-checkout-modal__error" role="alert">
          Could not record this sale. Check the details and try again.
        </p>
      ) : null}
      <Button onClick={handleConfirm} disabled={!canConfirm}>
        {status === "queued" ? "Recording..." : "Confirm sale"}
      </Button>
    </Modal>
  );
}
