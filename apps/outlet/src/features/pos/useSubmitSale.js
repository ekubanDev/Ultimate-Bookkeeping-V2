import { useCallback, useState } from "react";
import { generateClientId } from "@ub/offline-queue/idempotency.js";
import { enqueue } from "@ub/offline-queue";

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
   *   lineItems: Array<{ product_id: string, quantity: number, unit_price: string }>,
   *   paymentMethod: string,
   *   discountAmount?: string,
   *   taxAmount?: string,
   * }} params
   */
  const submitSale = useCallback(async (params) => {
    // client_id is generated exactly once here, at intent creation — never
    // regenerated if this same intent is retried by the offline-queue.
    const clientId = generateClientId();

    /** @type {import('@ub/shared-types').SaleRequest} */
    const payload = {
      client_id: clientId,
      outlet_id: params.outletId,
      line_items: params.lineItems,
      payment_method: params.paymentMethod,
      discount_amount: params.discountAmount ?? "0.00",
      tax_amount: params.taxAmount ?? "0.00",
      device_recorded_at: new Date().toISOString(),
    };

    const intent = {
      client_id: clientId,
      type: "sale",
      payload,
    };

    setStatus("queued");
    setError(null);

    try {
      // TODO(offline-queue): enqueue() is currently a stub — once
      // implemented it should resolve with the QueueEntry (status
      // 'queued'|'synced'|'failed') per the design doc §3 contract.
      const entry = await enqueue(intent);
      setStatus(entry?.status ?? "queued");
      return entry;
    } catch (err) {
      setStatus("failed");
      setError(err);
      throw err;
    }
  }, []);

  return { submitSale, status, error };
}
