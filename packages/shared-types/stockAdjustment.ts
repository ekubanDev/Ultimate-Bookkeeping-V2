/**
 * Types mirroring `POST /api/v1/stock/adjustments` and
 * `GET /api/v1/stock/levels`, per ultimate-bookkeeping-v2-api-contracts.md §3.
 */

import type { ApiError } from "./sale";

export type StockMovementReason =
  | "sale"
  | "restock"
  | "adjustment"
  | "transfer";

/** Request body for POST /api/v1/stock/adjustments */
export interface StockAdjustmentRequest {
  /** UUID generated on-device, once, at intent creation. Idempotency key. */
  client_id: string;
  product_id: string;
  outlet_id: string;
  /** positive (restock) or negative (adjustment/sale) */
  delta: number;
  reason: StockMovementReason;
}

/** 201 response body for POST /api/v1/stock/adjustments */
export interface StockAdjustmentResponse {
  id: string;
  client_id: string;
  product_id: string;
  outlet_id: string;
  delta: number;
  reason: StockMovementReason;
  /** Resulting stock_levels.quantity after this adjustment is applied. */
  quantity: number;
  created_at: string;
  idempotent_replay: boolean;
}

export type StockErrorCode = "PRODUCT_NOT_FOUND" | "VALIDATION_ERROR";
export type StockApiError = ApiError<StockErrorCode>;

/** Query params for GET /api/v1/stock/levels */
export interface StockLevelsQuery {
  outlet_id: string;
}

/** A single row from the stock_levels cache table. */
export interface StockLevel {
  product_id: string;
  outlet_id: string;
  quantity: number;
  updated_at: string;
}

export type StockLevelsResponse = StockLevel[];
