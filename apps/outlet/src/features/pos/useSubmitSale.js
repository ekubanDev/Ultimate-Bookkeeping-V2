import { useCallback, useState } from "react";
import { generateClientId } from "@ub/offline-queue/idempotency.js";
import { enqueue } from "@ub/offline-queue";

/**
 * buildSaleIntent — pure builder for the offline-queue Intent wrapping a
 * SaleRequest. Per tesseract-fp-guide.md §2/§4: no `Date.now()`/
 * `generateClientId()` calls inside — `deviceRecordedAt` and `clientId` are
 * inputs, generated at the edge (in submitSale below) and passed in. Given
 * the same arguments this always returns the same intent, so it's directly
 * unit-testable without touching IndexedDB or the clock.
 *
 * Cart-level discount is now a type+value pair (percentage or fixed GHS
 * amount), mirroring v1's `applyDiscount()` UX — a single pre-computed
 * `discount_amount` lost that semantic. Every line item carries its
 * catalog-seeded `submitted_unit_price`, persisted verbatim server-side;
 * the server, not this builder, is authoritative for
 * subtotal/discount/total (ultimate-bookkeeping-v2-api-contracts.md §2).
 *
 * @param {Array<{ product_id: string, quantity: number, submitted_unit_price: string }>} lineItems
 * @param {{
 *   outletId: string,
 *   paymentMethod: string,
 *   discountType?: import('@ub/shared-types').DiscountType,
 *   discountValue?: string,
 *   taxAmount?: string,
 *   deviceRecordedAt: string,
 *   clientId: string,
 * }} params
 * @returns {{ client_id: string, type: 'sale', payload: import('@ub/shared-types').SaleRequest }}
 */
export function buildSaleIntent(
  lineItems,
  {
    outletId,
    paymentMethod,
    discountType = "fixed",
    discountValue = "0.00",
    taxAmount = "0.00",
    deviceRecordedAt,
    clientId,
  }
) {
  /** @type {import('@ub/shared-types').SaleRequest} */
  const payload = {
    client_id: clientId,
    outlet_id: outletId,
    line_items: lineItems,
    payment_method: paymentMethod,
    discount_type: discountType,
    discount_value: discountValue,
    tax_amount: taxAmount,
    device_recorded_at: deviceRecordedAt,
  };

  return {
    client_id: clientId,
    type: "sale",
    payload,
  };
}

/**
 * useSubmitSale — builds the sale intent and hands it to the shared
 * offline-queue. Per ultimate-bookkeeping-v2-outlet-ui-plan.md §3: owns
 * building the `intent` object and exposing submission `status`. Does NOT
 * own cart state (that's useCart) or UI rendering.
 *
 * Maps 1:1 to POST /api/v1/sales (ultimate-bookkeeping-v2-api-contracts.md §2).
 */
export function useSubmitSale() {
  const [status, setStatus] = useState(/** @type {'idle'|'queued'|'synced'|'failed'} */ ("idle"));
  const [error, setError] = useState(null);

  /**
   * @param {{
   *   outletId: string,
   *   lineItems: Array<{ product_id: string, quantity: number, submitted_unit_price: string }>,
   *   paymentMethod: string,
   *   discountType?: import('@ub/shared-types').DiscountType,
   *   discountValue?: string,
   *   taxAmount?: string,
   * }} params
   */
  const submitSale = useCallback(async (params) => {
    // client_id and device_recorded_at are the two "edge" effects
    // (tesseract-fp-guide.md §2) — generated exactly once here, at intent
    // creation, then handed to the pure buildSaleIntent() as plain inputs.
    // client_id is never regenerated if this same intent is retried by the
    // offline-queue.
    const clientId = generateClientId();
    const deviceRecordedAt = new Date().toISOString();

    const intent = buildSaleIntent(params.lineItems, {
      outletId: params.outletId,
      paymentMethod: params.paymentMethod,
      discountType: params.discountType,
      discountValue: params.discountValue,
      taxAmount: params.taxAmount,
      deviceRecordedAt,
      clientId,
    });

    setStatus("queued");
    setError(null);

    try {
      // enqueue() persists write-first and returns fast (design doc §3.2) —
      // its `state` is almost always 'queued' here since dispatch happens
      // in the background; 'syncing' collapses to the same UI status.
      const entry = await enqueue(intent);
      setStatus(entry?.state === "syncing" ? "queued" : entry?.state ?? "queued");
      return entry;
    } catch (err) {
      setStatus("failed");
      setError(err);
      throw err;
    }
  }, []);

  return { submitSale, status, error };
}
