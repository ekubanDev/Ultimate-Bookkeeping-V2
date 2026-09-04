import { useEffect, useState } from "react";
import { Modal, Button, Input } from "@ub/shared-ui";
import { toCents, fromCents } from "./useCart.js";

/** NUMERIC(12,2)-shaped money string, e.g. "0.00" or "12.50". No parseFloat — this is a format check only. */
const MONEY_RE = /^\d+\.\d{2}$/;

/**
 * Percentage discount value: "0" through "100", at most 2 decimal places,
 * e.g. "0", "10", "10.5", "99.99", "100", "100.00" — but not "100.5"
 * (out of range) or "3.456" (too many decimals). Matched entirely by
 * regex, per CLAUDE.md/the FP guide's "no parseFloat" rule — a malformed
 * or out-of-range value can never sneak through via numeric coercion.
 */
const PERCENT_RE = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;

function isValidMoneyString(value) {
  return typeof value === "string" && MONEY_RE.test(value);
}

function isValidPercentString(value) {
  return typeof value === "string" && PERCENT_RE.test(value);
}

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "mobile_money", label: "Mobile Money" },
  { value: "card", label: "Card" },
];

/** Cart-level discount kinds — v1 parity (pos-controller.js#applyDiscount): a
 * cashier picks ONE of percentage-of-subtotal or a fixed GHS amount, never
 * both, and it's never a raw pre-computed money figure. */
const DISCOUNT_TYPES = [
  { value: "percentage", label: "Percentage (%)" },
  { value: "fixed", label: "Fixed amount (GHS)" },
];

/**
 * previewTotalCents — pure helper computing the cashier-facing estimated
 * total from a subtotal, a discount type/value, and a tax amount, all in
 * integer cents (no floats). Exported for direct unit testing.
 *
 * This is a PREVIEW ONLY. The server is the sole pricing authority
 * (ultimate-bookkeeping-v2-api-contracts.md §2): `POST /api/v1/sales`
 * independently computes `subtotal_amount`/`discount_amount`/
 * `total_amount` from the persisted line items and
 * `discount_type`/`discount_value` — none of those three are ever accepted
 * from the client. The 201 response's `total_amount` is the real,
 * receipt-worthy figure; this function only exists so the till doesn't
 * show the cashier a blank/stale total while they're filling in the
 * checkout form.
 *
 * For a percentage discount, division only happens once and is rounded
 * half-up, matching the server's rounding rule, so this preview can't
 * disagree with the eventual receipt by a pesewa.
 *
 * @param {number} subtotalCents
 * @param {{ discountType: 'percentage'|'fixed', discountValue: string, taxCents: number }} params
 * @returns {number}
 */
export function previewTotalCents(subtotalCents, { discountType, discountValue, taxCents }) {
  let discountCents;

  if (discountType === "percentage") {
    // discountValue is a "0"–"100"(.dd) string. toCents() parses any
    // 2dp-max decimal string into an integer scaled by 100, regardless of
    // unit, so "10.00" -> 1000 here means "10.00 percent, scaled by 100"
    // (i.e. hundredths of a percent) — reusing useCart's money helper for
    // this non-money value, per the task's "reuse toCents/fromCents" note.
    const percentHundredths = toCents(discountValue);
    const numerator = subtotalCents * percentHundredths;
    const denominator = 10000; // cents * (percent * 100) / (100 * 100)
    const quotient = Math.floor(numerator / denominator);
    const remainder = numerator - quotient * denominator;
    // Round half-up, exactly once.
    discountCents = remainder * 2 >= denominator ? quotient + 1 : quotient;
  } else {
    discountCents = toCents(discountValue);
  }

  // A discount can never exceed the subtotal in this preview, mirroring
  // common sense at the till even though the server has final say.
  discountCents = Math.min(discountCents, subtotalCents);

  return Math.max(subtotalCents - discountCents + taxCents, 0);
}

/**
 * CheckoutModal — collects payment method, cart-level discount (type +
 * value), tax, and confirms the sale.
 *
 * Owns: checkout-step UI (payment method selection, discount type toggle +
 * value entry, tax entry, confirm/cancel, rendering the `failed` status per
 * useSubmitSale's status mapping). Discount is percentage-OR-fixed at the
 * cart level, never a pre-computed money amount — restoring v1's
 * `applyDiscount()` semantics that the original v2 contract had collapsed
 * into a single `discount_amount` (see api-contracts.md §2).
 * Does NOT own: cart contents (receives `subtotal` as a prop, pre-discount/
 * tax) or the actual submission — calls
 * `onConfirm({ paymentMethod, discountType, discountValue, taxAmount })`,
 * which PosScreen wires to useSubmitSale.submitSale. Does NOT own pricing
 * authority — the estimated total shown here is a preview only; see
 * previewTotalCents' doc comment.
 */
export default function CheckoutModal({
  isOpen,
  onClose,
  subtotal = "0.00",
  onConfirm,
  status = "idle",
}) {
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [discountType, setDiscountType] = useState("percentage");
  const [discountValue, setDiscountValue] = useState("0.00");
  const [taxAmount, setTaxAmount] = useState("0.00");

  // Fresh checkout inputs every time the modal opens — CheckoutModal stays
  // mounted across opens/closes (PosScreen always renders it), so this
  // clears out whatever was typed on a prior, possibly-failed, attempt.
  useEffect(() => {
    if (isOpen) {
      setPaymentMethod("cash");
      setDiscountType("percentage");
      setDiscountValue("0.00");
      setTaxAmount("0.00");
    }
  }, [isOpen]);

  const discountValid =
    discountType === "percentage"
      ? isValidPercentString(discountValue)
      : isValidMoneyString(discountValue);
  const taxValid = isValidMoneyString(taxAmount);
  const canConfirm = discountValid && taxValid && status !== "queued";

  // Client-side estimate only — see previewTotalCents' doc comment above;
  // the server's response total_amount is the figure that actually counts.
  const previewTotal =
    discountValid && taxValid
      ? fromCents(
          previewTotalCents(toCents(subtotal), {
            discountType,
            discountValue,
            taxCents: toCents(taxAmount),
          })
        )
      : null;

  const handleDiscountTypeChange = (nextType) => {
    setDiscountType(nextType);
    // v1 parity: a raw number typed for one type is meaningless under the
    // other ("10" as a fixed GHS amount vs. 10% are unrelated) — reset to
    // a safe, always-valid default for the newly-selected type rather than
    // silently reinterpreting whatever was already typed.
    setDiscountValue("0.00");
  };

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm?.({ paymentMethod, discountType, discountValue, taxAmount });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Checkout">
      <p>Subtotal: {subtotal}</p>
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

      <fieldset className="ub-checkout-modal__discount-type">
        <legend>Discount</legend>
        {DISCOUNT_TYPES.map((dt) => (
          <label key={dt.value} className="ub-checkout-modal__discount-type-option">
            <input
              type="radio"
              name="checkout-discount-type"
              value={dt.value}
              checked={discountType === dt.value}
              onChange={() => handleDiscountTypeChange(dt.value)}
            />
            {dt.label}
          </label>
        ))}
      </fieldset>

      <Input
        label={discountType === "percentage" ? "Discount value (%)" : "Discount value (GHS)"}
        id="checkout-discount-value"
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        value={discountValue}
        onChange={(e) => setDiscountValue(e.target.value)}
      />
      {!discountValid ? (
        <p className="ub-checkout-modal__field-error" role="alert">
          {discountType === "percentage"
            ? 'Discount must be a percentage from "0" to "100", with at most 2 decimal places.'
            : 'Discount must be a NUMERIC(12,2) amount, e.g. "0.00".'}
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

      {previewTotal !== null ? (
        // Estimate only — the receipt-worthy figure is the server's
        // total_amount from the POST /api/v1/sales response, not this.
        <p className="ub-checkout-modal__total-preview">
          Estimated total: {previewTotal}
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
