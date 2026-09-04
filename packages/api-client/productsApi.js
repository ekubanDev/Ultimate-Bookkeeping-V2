/**
 * Thin wrapper over the product-catalog endpoint. See
 * ultimate-bookkeeping-v2-api-contracts.md §3 (catalog). Called by
 * useProducts.js (reads).
 */
import { apiFetch } from "./_base.js";

/**
 * GET /api/v1/products?outlet_id=&limit=&offset= — tenant-scoped
 * server-side via the same resolve_authorized_outlet path as every other
 * endpoint, ordered by name. Server default limit 50, max 200. Reads are
 * not offline-eligible (CLAUDE.md constraint: offline-first applies only
 * to sales, stock adjustments, expenses) — this is a plain GET, not queued.
 * @param {import('@ub/shared-types').ProductsQuery} query
 * @returns {Promise<import('@ub/shared-types').ProductsResponse>}
 */
export function getProducts(query) {
  const params = new URLSearchParams(
    Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== null)
    )
  );
  return apiFetch(`/products?${params.toString()}`, { method: "GET" });
}
