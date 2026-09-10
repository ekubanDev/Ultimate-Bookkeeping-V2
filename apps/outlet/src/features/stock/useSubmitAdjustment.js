import { useCallback, useState } from "react";
import { generateClientId } from "@ub/offline-queue/idempotency.js";
import { enqueue } from "@ub/offline-queue";
import { useAuth } from "../../auth/AuthContext.jsx";

/**
 * buildAdjustmentIntent — pure builder for the offline-queue Intent
 * wrapping a StockAdjustmentRequest. Per tesseract-fp-guide.md §2/§4: no
 * `generateClientId()` call inside — `clientId` is an input, generated at
 * the edge (in submitAdjustment below) and passed in. Given the same
 * arguments this always returns the same intent.
 *
 * Unlike sales/expenses, StockAdjustmentRequest carries no
 * `device_recorded_at` field (see shared-types/stockAdjustment.ts) — nothing
 * to build at the edge here beyond the client_id.
 *
 * @param {{
 *   productId: string,
 *   outletId: string,
 *   delta: number,
 *   reason?: import('@ub/shared-types').StockMovementReason,
 *   clientId: string,
 * }} params
 * @returns {{ client_id: string, type: 'stock_adjustment', payload: import('@ub/shared-types').StockAdjustmentRequest }}
 */
export function buildAdjustmentIntent({ productId, outletId, delta, reason = "adjustment", clientId }) {
  /** @type {import('@ub/shared-types').StockAdjustmentRequest} */
  const payload = {
    client_id: clientId,
    product_id: productId,
    outlet_id: outletId,
    delta,
    reason,
  };

  return {
    client_id: clientId,
    type: "stock_adjustment",
    payload,
  };
}

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
  const { profile } = useAuth();
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

    const intent = buildAdjustmentIntent({
      productId: params.productId,
      outletId: params.outletId,
      delta: params.delta,
      reason: params.reason,
      clientId,
    });

    setStatus("queued");
    setError(null);

    try {
      // enqueue() persists write-first and returns fast (design doc §3.2) —
      // its `state` is almost always 'queued' here since dispatch happens
      // in the background; 'syncing' collapses to the same UI status.
      // `createdBy` binds the acting user's id at enqueue time — see the
      // matching note in useSubmitSale.js.
      const entry = await enqueue(intent, { createdBy: profile?.id ?? null });
      setStatus(entry?.state === "syncing" ? "queued" : entry?.state ?? "queued");
      return entry;
    } catch (err) {
      setStatus("failed");
      setError(err);
      throw err;
    }
  }, [profile?.id]);

  return { submitAdjustment, status, error };
}
