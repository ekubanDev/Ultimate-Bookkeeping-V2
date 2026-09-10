/**
 * Thin wrapper over the stock endpoints. See
 * ultimate-bookkeeping-v2-api-contracts.md §3. Called by
 * useSubmitAdjustment.js (via offline-queue) and StockLevelList.jsx (reads).
 */
import { apiFetch } from "./_base.js";

/**
 * POST /api/v1/stock/adjustments
 * @param {import('@ub/shared-types').StockAdjustmentRequest} adjustmentRequest
 * @returns {Promise<import('@ub/shared-types').StockAdjustmentResponse>}
 */
export function postStockAdjustment(adjustmentRequest) {
  return apiFetch("/stock/adjustments", {
    method: "POST",
    body: JSON.stringify(adjustmentRequest),
  });
}

/**
 * GET /api/v1/stock/levels?outlet_id= — reads the stock_levels cache table,
 * not a live aggregate (api-contracts.md §3).
 * @param {import('@ub/shared-types').StockLevelsQuery} query
 * @returns {Promise<import('@ub/shared-types').StockLevelsResponse>}
 */
export function getStockLevels(query) {
  const params = new URLSearchParams(query);
  return apiFetch(`/stock/levels?${params.toString()}`, { method: "GET" });
}
