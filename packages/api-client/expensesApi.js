/**
 * Thin wrapper over the expenses endpoint. See
 * ultimate-bookkeeping-v2-api-contracts.md §4. Called by
 * useSubmitExpense.js (via offline-queue).
 */
import { apiFetch } from "./_base.js";

/**
 * POST /api/v1/expenses
 * @param {import('@ub/shared-types').ExpenseRequest} expenseRequest
 * @returns {Promise<import('@ub/shared-types').ExpenseResponse>}
 */
export function postExpense(expenseRequest) {
  return apiFetch("/expenses", {
    method: "POST",
    body: JSON.stringify(expenseRequest),
  });
}
