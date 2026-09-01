import { useCallback, useState } from "react";
import { generateClientId } from "@ub/offline-queue/idempotency.js";
import { enqueue } from "@ub/offline-queue";

/**
 * useSubmitExpense — builds the expense intent and hands it to the shared
 * offline-queue. Mirrors useSubmitSale/useSubmitAdjustment's shape (per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §3).
 *
 * Maps 1:1 to POST /api/v1/expenses
 * (ultimate-bookkeeping-v2-api-contracts.md §4).
 */
export function useSubmitExpense() {
  const [status, setStatus] = useState(/** @type {'idle'|'queued'|'synced'|'failed'} */ ("idle"));
  const [error, setError] = useState(null);

  /**
   * @param {{
   *   outletId: string,
   *   amount: string,
   *   category: string,
   *   note?: string,
   * }} params
   */
  const submitExpense = useCallback(async (params) => {
    // Generated once, at intent creation — never regenerated on retry.
    const clientId = generateClientId();

    /** @type {import('@ub/shared-types').ExpenseRequest} */
    const payload = {
      client_id: clientId,
      outlet_id: params.outletId,
      amount: params.amount,
      category: params.category,
      note: params.note,
      device_recorded_at: new Date().toISOString(),
    };

    const intent = {
      client_id: clientId,
      type: "expense",
      payload,
    };

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

  return { submitExpense, status, error };
}
