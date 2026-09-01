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

/**
 * Local queue-entry lifecycle state, persisted in IndexedDB and surfaced to
 * useSyncStatus/SyncBanner.
 *
 *  - queued:    persisted, waiting for (or between retries of) dispatch.
 *  - syncing:   a dispatch attempt is in flight right now.
 *  - synced:    server accepted the write — either a fresh insert or an
 *               idempotent replay (design doc §3.4 treats both as success).
 *  - failed:    server returned a non-retryable rejection (design doc §3.4)
 *               — needs human resolution via retryEntry()/discardEntry().
 *  - discarded: user explicitly abandoned a failed entry. Kept for audit
 *               (never hard-deleted) but excluded from dispatch/flush.
 */
export type QueueEntryState =
  | "queued"
  | "syncing"
  | "synced"
  | "failed"
  | "discarded";

/** Structured rejection stored on an entry, mirrors the api-contracts.md §1 error envelope. */
export interface QueueEntryError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * A persisted queue entry — the unit of work stored in IndexedDB, keyed by
 * `client_id`. `client_id` is generated once by the caller (see
 * idempotency.js) and never regenerated here, including across retries.
 */
export interface QueueEntry<TPayload = unknown> {
  client_id: string;
  type: IntentType;
  payload: TPayload;
  state: QueueEntryState;
  /** Number of dispatch attempts made so far (0 before the first attempt completes). */
  attempts: number;
  /** Set on the most recent failed/retried attempt; cleared on success. */
  last_error: QueueEntryError | null;
  /** epoch ms — when this intent was first persisted. Drives FIFO replay order. */
  enqueued_at: number;
  /** epoch ms — set once state becomes 'synced'. */
  synced_at: number | null;
  /**
   * Monotonic tiebreaker for FIFO ordering when two entries share the same
   * `enqueued_at` millisecond (rapid-fire POS entry on a fast device).
   * Internal to this package — not part of the design doc's entry shape but
   * doesn't change it, just makes FIFO deterministic.
   */
  seq: number;
}

/** Aggregate view used by useSyncStatus to drive SyncBanner without polling. */
export interface QueueSnapshot {
  counts: Record<QueueEntryState, number>;
  entries: QueueEntry[];
}

/** Listener signature for subscribe() — called with the full snapshot on every state transition. */
export type QueueSnapshotListener = (snapshot: QueueSnapshot) => void;
