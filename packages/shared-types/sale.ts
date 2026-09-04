/**
 * Types mirroring `POST /api/v1/sales` (and `GET /api/v1/sales`) exactly, per
 * ultimate-bookkeeping-v2-api-contracts.md §2.
 *
 * Money fields are strings representing NUMERIC(12,2) over the wire — never
 * JS floats (see CLAUDE.md "Non-negotiable constraints").
 */

export type PaymentMethod = "cash" | "mobile_money" | "card" | string;

export type SaleStatus = "completed" | "voided";

/** How `discount_value` should be interpreted for a sale. */
export type DiscountType = "percentage" | "fixed";

export interface SaleLineItemRequest {
  /** Catalog-only — every line item references a real product. */
  product_id: string;
  quantity: number;
  /**
   * NUMERIC(12,2) as a string, e.g. "15.00". Persisted verbatim server-side
   * as `sale_line_items.unit_price` — never silently replaced by a live
   * catalog lookup. The server independently computes `subtotal_amount`,
   * `discount_amount`, and `total_amount`; none of those are accepted from
   * the client.
   */
  submitted_unit_price: string;
}

/** Request body for POST /api/v1/sales */
export interface SaleRequest {
  /** UUID generated on-device, once, at intent creation. Idempotency key. */
  client_id: string;
  outlet_id: string;
  line_items: SaleLineItemRequest[];
  payment_method: PaymentMethod;
  /** Cart-level discount kind — percentage or a fixed GHS amount. */
  discount_type: DiscountType;
  /**
   * NUMERIC(12,2)-shaped string whose *meaning* depends on `discount_type`:
   * "0.00"–"100.00" when `discount_type` is "percentage" (not a money
   * amount — the decimal type is reused for precision only), or a GHS money
   * amount when `discount_type` is "fixed".
   */
  discount_value: string;
  /** NUMERIC(12,2) as a string */
  tax_amount: string;
  /** Client-side timestamp, audit-only — never used for ordering. ISO 8601. */
  device_recorded_at: string;
}

/** 201 response body for POST /api/v1/sales */
export interface SaleResponse {
  id: string;
  client_id: string;
  status: SaleStatus;
  /** NUMERIC(12,2) as a string — server-computed sum of line items before discount/tax. */
  subtotal_amount: string;
  /** NUMERIC(12,2) as a string — server-computed money value of the discount. */
  discount_amount: string;
  /** NUMERIC(12,2) as a string */
  tax_amount: string;
  /** NUMERIC(12,2) as a string — the authoritative total. The client's own preview total is never trusted. */
  total_amount: string;
  /**
   * True when a submitted line's `submitted_unit_price` diverged from the
   * live catalog price beyond the server's tolerance. Admin-review signal
   * only — never blocks or alarms the till.
   */
  price_variance_flagged: boolean;
  /** Server-assigned. ISO 8601. */
  created_at: string;
  /** True if this response is a safe re-send of a prior insert, not a fresh one. */
  idempotent_replay: boolean;
}

/** Body for POST /api/v1/sales/{id}/void — not offline-eligible. */
export interface SaleVoidRequest {
  reason: string;
}

export type SaleErrorCode =
  | "PRODUCT_NOT_FOUND"
  | "INSUFFICIENT_STOCK"
  | "VALIDATION_ERROR";

/** Standard error envelope, per api-contracts.md §1. */
export interface ApiError<Code extends string = string> {
  error: {
    code: Code;
    message: string;
    /** true = worth re-queuing (transient); false = needs human resolution. */
    retryable: boolean;
  };
}

export type SaleApiError = ApiError<SaleErrorCode>;

/** Query params for GET /api/v1/sales */
export interface SalesListQuery {
  outlet_id: string;
  from?: string;
  to?: string;
}
