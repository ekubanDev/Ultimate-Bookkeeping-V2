/**
 * Types mirroring `POST /api/v1/expenses`, per
 * ultimate-bookkeeping-v2-api-contracts.md §4.
 */

import type { ApiError } from "./sale";

/** Request body for POST /api/v1/expenses */
export interface ExpenseRequest {
  /** UUID generated on-device, once, at intent creation. Idempotency key. */
  client_id: string;
  outlet_id: string;
  /** NUMERIC(12,2) as a string, e.g. "50.00" */
  amount: string;
  category: string;
  note?: string;
  /** Client-side timestamp, audit-only — never used for ordering. ISO 8601. */
  device_recorded_at: string;
}

export type ExpenseStatus = "completed" | "voided";

/** 201 response body for POST /api/v1/expenses — same idempotent-replay pattern as sales. */
export interface ExpenseResponse {
  id: string;
  client_id: string;
  status: ExpenseStatus;
  /** NUMERIC(12,2) as a string */
  amount: string;
  created_at: string;
  idempotent_replay: boolean;
}

export type ExpenseErrorCode = "VALIDATION_ERROR";
export type ExpenseApiError = ApiError<ExpenseErrorCode>;
