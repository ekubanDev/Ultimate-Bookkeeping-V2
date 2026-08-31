import { useCallback, useState } from "react";
import { generateClientId } from "@ub/offline-queue/idempotency.js";
import { enqueue } from "@ub/offline-queue";

/**
 * useSubmitAdjustment — builds the stock-adjustment intent and hands it to
 * the shared offline-queue. Mirrors useSubmitSale's shape (per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §3): owns building the intent
 * and exposing `status`, nothing else.
 *
 * Maps 1:1 to POST /api/v1/stock/adjustments
 * (ultimate-bookkeeping-v2-api-contracts.md §3).
 */
export function useSubmitAdjustment() {
  const [status, setStatus] = useState(/** @type {'idle'|'queued'|'synced'|'failed'} */ ("idle"));
  const [error, setError] = useState(null);

  /**
   * @param {{
   *   productId: string,
   *   outletId: string,
   *   delta: number,
   *   reason?: import('@ub/shared-types').StockMovementReason,
   * }} params
   */
  const submitAdjustment = useCallback(async (params) => {
    // Generated once, at intent creation — never regenerated on retry.
    const clientId = generateClientId();

    /** @type {import('@ub/shared-types').StockAdjustmentRequest} */
    const payload = {
      client_id: clientId,
      product_id: params.productId,
      outlet_id: params.outletId,
      delta: params.delta,
      reason: params.reason ?? "adjustment",
    };

    const intent = {
      client_id: clientId,
      type: "stock_adjustment",
      payload,
    };

    setStatus("queued");
    setError(null);

    try {
      // TODO(offline-queue): enqueue() is currently a stub.
      const entry = await enqueue(intent);
      setStatus(entry?.status ?? "queued");
      return entry;
    } catch (err) {
      setStatus("failed");
      setError(err);
      throw err;
    }
  }, []);

  return { submitAdjustment, status, error };
}
