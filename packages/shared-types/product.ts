/**
 * Types mirroring `GET /api/v1/products`, per
 * ultimate-bookkeeping-v2-api-contracts.md §? (catalog endpoint).
 *
 * Tenant-scoped server-side via the same resolve_authorized_outlet path as
 * every other endpoint — the client never filters by outlet itself, it just
 * passes outlet_id through.
 */

/** Query params for GET /api/v1/products */
export interface ProductsQuery {
  outlet_id: string;
  /** Server default 50, max 200. */
  limit?: number;
  offset?: number;
}

/** A single row from the product catalog, ordered by name server-side. */
export interface Product {
  id: string;
  /** Nullable — not every product has a SKU assigned yet. */
  sku: string | null;
  name: string;
  /** NUMERIC(12,2) as a string, e.g. "15.00" — never a JS float. */
  unit_price: string;
  /** Nullable — null means "no low-stock threshold configured", not zero. */
  min_stock: number | null;
}

export type ProductsResponse = Product[];
