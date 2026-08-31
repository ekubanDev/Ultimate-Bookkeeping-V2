/**
 * Shared types for the offline-queue package. See
 * ultimate-bookkeeping-v2-design.md §3 for the full offline-write contract.
 */

/** The three offline-eligible intent types, per design doc §3.6. */
export type IntentType = "sale" | "stock_adjustment" | "expense";

/**
 * The generic envelope every offline-eligible write is wrapped in before
 * being handed to enqueue(). `payload` is the type-specific request body
 * from @ub/shared-types (SaleRequest | StockAdjustmentRequest | ExpenseRequest).
 */
export interface Intent<TPayload = unknown> {
  /** UUID, generated once at creation via idempotency.js#generateClientId */
  client_id: string;
  type: IntentType;
  payload: TPayload;
}

/** Local queue-entry lifecycle state, surfaced to useSubmit* hooks as `status`. */
export type QueueEntryStatus = "idle" | "queued" | "synced" | "failed";

export interface QueueEntry<TPayload = unknown> {
  intent: Intent<TPayload>;
  status: QueueEntryStatus;
  /** Increments on each retry attempt; used for backoff scheduling. */
  attempts: number;
  /** Set only when status === 'failed' and the server rejection was non-retryable. */
  lastError?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
