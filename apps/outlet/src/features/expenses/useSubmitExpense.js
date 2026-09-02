import { useCallback, useState } from "react";
import { generateClientId } from "@ub/offline-queue/idempotency.js";
import { enqueue } from "@ub/offline-queue";

/**
 * buildExpenseIntent — pure builder for the offline-queue Intent wrapping
 * an ExpenseRequest. Per tesseract-fp-guide.md §2/§4: no
 * `Date.now()`/`generateClientId()` calls inside — `deviceRecordedAt` and
 * `clientId` are inputs, generated at the edge (in submitExpense below) and
 * passed in. Given the same arguments this always returns the same intent.
 *
 * @param {{
 *   outletId: string,
 *   amount: string,
 *   category: string,
 *   note?: string,
 *   deviceRecordedAt: string,
 *   clientId: string,
 * }} params
 * @returns {{ client_id: string, type: 'expense', payload: import('@ub/shared-types').ExpenseRequest }}
 */
export function buildExpenseIntent({ outletId, amount, category, note, deviceRecordedAt, clientId }) {
  /** @type {import('@ub/shared-types').ExpenseRequest} */
  const payload = {
    client_id: clientId,
    outlet_id: outletId,
    amount,
    category,
    note,
    device_recorded_at: deviceRecordedAt,
  };

  return {
    client_id: clientId,
    type: "expense",
    payload,
  };
}

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
    const deviceRecordedAt = new Date().toISOString();

    const intent = buildExpenseIntent({
      outletId: params.outletId,
      amount: params.amount,
      category: params.category,
      note: params.note,
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

  return { submitExpense, status, error };
}
