/**
 * Types mirroring `POST /api/v1/sales` (and `GET /api/v1/sales`) exactly, per
 * ultimate-bookkeeping-v2-api-contracts.md §2.
 *
 * Money fields are strings representing NUMERIC(12,2) over the wire — never
 * JS floats (see CLAUDE.md "Non-negotiable constraints").
 */

export type PaymentMethod = "cash" | "mobile_money" | "card" | string;

export type SaleStatus = "completed" | "voided";

export interface SaleLineItemRequest {
  product_id: string;
  quantity: number;
  /** NUMERIC(12,2) as a string, e.g. "15.00" */
  unit_price: string;
}

/** Request body for POST /api/v1/sales */
export interface SaleRequest {
  /** UUID generated on-device, once, at intent creation. Idempotency key. */
  client_id: string;
  outlet_id: string;
  line_items: SaleLineItemRequest[];
  payment_method: PaymentMethod;
  /** NUMERIC(12,2) as a string */
  discount_amount: string;
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
  /** NUMERIC(12,2) as a string */
  total_amount: string;
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
