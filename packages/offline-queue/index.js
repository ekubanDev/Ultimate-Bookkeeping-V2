/**
 * Shared offline-queue package — the single implementation of "write an
 * intent locally, sync it when connectivity returns" used by sales, stock
 * adjustments, and expenses (and nothing else — see design doc §3.6).
 *
 * This is intentionally NOT feature-specific: /features/pos, /features/stock,
 * and /features/expenses all call into this same module rather than each
 * rolling their own IndexedDB queue. See
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §2 for why this is split out.
 *
 * Full contract: ultimate-bookkeeping-v2-design.md §3
 *   - §3.2 intent shape
 *   - §3.3 idempotency (client_id, generated once, never regenerated)
 *   - §3.4 server-side processing / retryable vs. non-retryable errors
 *   - §3.5 ordering (created_at is server-assigned, device_recorded_at is audit-only)
 *
 * Everything below is a stub: signatures + TODOs, no implementation yet.
 */

/**
 * Enqueues an intent for submission. If online, this should attempt an
 * immediate POST; if offline (or the POST fails transiently), the intent is
 * persisted to the local IndexedDB queue and retried on reconnect.
 *
 * @param {import('./types').Intent} intent
 * @returns {Promise<import('./types').QueueEntry>}
 */
export function enqueue(intent) {
  // TODO: persist `intent` to IndexedDB queue store (see design doc §3.2).
  // TODO: if navigator.onLine, attempt immediate POST via the matching
  //       @ub/api-client function; on success mark 'synced', on retryable
  //       failure leave 'queued' for onReconnect() to retry, on
  //       non-retryable failure mark 'failed' with the error envelope.
  // TODO: return the QueueEntry so callers (useSubmit*) can read `status`.
  throw new Error("offline-queue.enqueue: not yet implemented — see design doc §3");
}

/**
 * Registers the reconnect handler that drains the local queue and retries
 * every 'queued' entry in order, respecting §3.3 idempotency (same
 * client_id on every retry) and §3.4 error handling (retryable vs. not).
 *
 * Should be called once at app startup (see /apps/outlet/src/App.jsx).
 *
 * @param {(entry: import('./types').QueueEntry) => void} [onEntryUpdate]
 *   optional callback fired whenever a queued entry's status changes —
 *   this is what useSyncStatus subscribes to.
 * @returns {() => void} unsubscribe function
 */
export function onReconnect(onEntryUpdate) {
  // TODO: attach a 'online' event listener (and/or periodic connectivity
  //       probe, since 'online' is unreliable on some Android browsers).
  // TODO: on trigger, drain the IndexedDB queue in FIFO order, POSTing each
  //       queued/failed(retryable) entry via retry logic below.
  throw new Error("offline-queue.onReconnect: not yet implemented — see design doc §3");
}

/**
 * Retries a single queue entry: re-POSTs the same intent (same client_id —
 * never regenerated) and updates its status based on the response, per
 * design doc §3.4:
 *   - 201 with idempotent_replay: false|true -> 'synced'
 *   - structured rejection, retryable: true  -> stays 'queued', backoff and retry
 *   - structured rejection, retryable: false -> 'failed', surfaced to the
 *     user via SyncBanner's "resolve" state
 *
 * @param {import('./types').QueueEntry} entry
 * @returns {Promise<import('./types').QueueEntry>}
 */
export function retryEntry(entry) {
  // TODO: implement per the contract above.
  throw new Error("offline-queue.retryEntry: not yet implemented — see design doc §3.4");
}

/**
 * Reads the current queue snapshot (all entries, any status). Used by
 * useSyncStatus to render SyncBanner's "N items syncing" / "sync failed"
 * states without owning retry logic itself.
 *
 * @returns {Promise<import('./types').QueueEntry[]>}
 */
export function getQueueSnapshot() {
  // TODO: read all entries from the IndexedDB queue store.
  throw new Error("offline-queue.getQueueSnapshot: not yet implemented — see design doc §3");
}
