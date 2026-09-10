/**
 * Thin wrapper over the sales endpoints. See
 * ultimate-bookkeeping-v2-api-contracts.md §2. Called by
 * useSubmitSale.js (via offline-queue) and, later, admin sales views.
 */
import { apiFetch } from "./_base.js";

/**
 * POST /api/v1/sales
 * @param {import('@ub/shared-types').SaleRequest} saleRequest
 * @returns {Promise<import('@ub/shared-types').SaleResponse>}
 */
export function postSale(saleRequest) {
  return apiFetch("/sales", {
    method: "POST",
    body: JSON.stringify(saleRequest),
  });
}

/**
 * POST /api/v1/sales/{id}/void — not offline-eligible, online-only.
 * @param {string} saleId
 * @param {{reason: string}} body
 */
export function voidSale(saleId, body) {
  return apiFetch(`/sales/${saleId}/void`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * GET /api/v1/sales?outlet_id=&from=&to=
 * @param {import('@ub/shared-types').SalesListQuery} query
 */
export function listSales(query) {
  const params = new URLSearchParams(query);
  return apiFetch(`/sales?${params.toString()}`, { method: "GET" });
}
