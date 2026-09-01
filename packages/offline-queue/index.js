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
 *   - §3.2 intent shape / write-first persistence
 *   - §3.3 idempotency (client_id, generated once, never regenerated)
 *   - §3.4 server-side processing / retryable vs. non-retryable errors
 *   - §3.5 ordering (created_at is server-assigned, device_recorded_at is audit-only)
 */

import { postSale, postStockAdjustment, postExpense, ApiClientError } from "@ub/api-client";
import { getAllEntries, getEntry, putEntry } from "./db.js";

/** Maps an intent `type` to the @ub/api-client function that submits it. */
const DISPATCHERS = {
  sale: (payload) => postSale(payload),
  stock_adjustment: (payload) => postStockAdjustment(payload),
  expense: (payload) => postExpense(payload),
};

/** Backoff cap, per design doc §3.4 retry guidance ("retry later with capped exponential backoff"). */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

let seqCounter = 0;
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

/** client_id -> setTimeout handle, for pending backoff retries. */
const retryTimers = new Map();

/** snapshot listeners, per §6 subscribe() contract. */
const listeners = new Set();

/** In-flight flush loop promise, or null when idle. See flush() below. */
let flushPromise = null;

function isOnline() {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") {
    // No `navigator` (Node/test/SSR environment) — assume online; a real
    // dispatch attempt will surface the true network state via a rejected
    // fetch, which the retry path already treats as retryable.
    return true;
  }
  return navigator.onLine;
}

function backoffDelayMs(attempts) {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

function clearScheduledRetry(clientId) {
  const timerId = retryTimers.get(clientId);
  if (timerId !== undefined) {
    clearTimeout(timerId);
    retryTimers.delete(clientId);
  }
}

/**
 * Schedules a background retry via flush() after a capped exponential
 * backoff. Browser-only: in non-browser environments (Node, tests, SSR)
 * there's no ambient timer loop to rely on, so retries there are driven
 * explicitly by calling flush()/onReconnect's 'online' handler.
 * @param {import('./types').QueueEntry} entry
 */
function scheduleRetry(entry) {
  clearScheduledRetry(entry.client_id);
  if (typeof window === "undefined" || typeof window.setTimeout !== "function") {
    return;
  }
  const delay = backoffDelayMs(entry.attempts);
  const timerId = setTimeout(() => {
    retryTimers.delete(entry.client_id);
    flush().catch(() => {});
  }, delay);
  retryTimers.set(entry.client_id, timerId);
}

function toStructuredError(err) {
  if (err instanceof ApiClientError) {
    return { code: err.code, message: err.message, retryable: !!err.retryable };
  }
  // Network failure (fetch rejected, offline, DNS, etc.) or anything else
  // unexpected — treat as transient/retryable per design doc §3.4 ("or a
  // network failure" in the dispatch contract).
  return {
    code: "NETWORK_ERROR",
    message: (err && err.message) || "Network error",
    retryable: true,
  };
}

/** Persists an entry and notifies subscribers with the fresh snapshot. */
async function persistAndNotify(entry) {
  await putEntry(entry);
  const snapshot = await getQueueSnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // A listener throwing must never break the queue's own state machine.
    }
  }
  return entry;
}

/**
 * Enqueues an intent for submission. Persists it to IndexedDB immediately
 * (write-first — the sale is "recorded" the moment IndexedDB accepts it,
 * per design doc §3.2), then — if online — kicks off dispatch in the
 * background via flush(). Never awaits the network: returns as soon as the
 * entry is durably queued so the POS flow is never blocked.
 *
 * @param {import('./types').Intent} intent
 * @returns {Promise<import('./types').QueueEntry>}
 */
export async function enqueue(intent) {
  if (!intent || !intent.client_id || !intent.type) {
    throw new Error("offline-queue.enqueue: intent requires client_id and type");
  }
  if (!DISPATCHERS[intent.type]) {
    throw new Error(`offline-queue.enqueue: unknown intent type "${intent.type}"`);
  }

  const now = Date.now();
  /** @type {import('./types').QueueEntry} */
  const entry = {
    client_id: intent.client_id,
    type: intent.type,
    payload: intent.payload,
    state: "queued",
    attempts: 0,
    last_error: null,
    enqueued_at: now,
    synced_at: null,
    seq: nextSeq(),
  };

  await persistAndNotify(entry);

  if (isOnline()) {
    // Fire-and-forget: dispatch happens via the shared, sequential flush()
    // loop. Callers that need to know when it lands can `await flush()`
    // themselves (flush() is safe to call redundantly — see below).
    flush().catch(() => {});
  }

  return entry;
}

/**
 * Dispatches a single queued entry: re-POSTs the same intent (same
 * client_id — never regenerated) via the matching @ub/api-client function,
 * and updates its persisted state based on the response, per design doc
 * §3.4:
 *   - 2xx (idempotent_replay true or false — both are success) -> 'synced'
 *   - retryable:true error, or a network failure                -> stays
 *     'queued', attempts++, backoff-scheduled retry
 *   - retryable:false error                                     -> 'failed',
 *     no further automatic attempts — surfaced via SyncBanner's "resolve"
 *     state until retryEntry()/discardEntry() is called
 *
 * @param {import('./types').QueueEntry} entry
 * @returns {Promise<import('./types').QueueEntry>}
 */
async function dispatchEntry(entry) {
  clearScheduledRetry(entry.client_id);
  await persistAndNotify({ ...entry, state: "syncing" });

  const dispatch = DISPATCHERS[entry.type];

  try {
    // idempotent_replay is intentionally not branched on here — per the
    // design/API contracts, a fresh insert and a safe re-send are BOTH
    // success from the queue's perspective.
    await dispatch(entry.payload);
    const synced = {
      ...entry,
      state: "synced",
      attempts: entry.attempts + 1,
      last_error: null,
      synced_at: Date.now(),
    };
    await persistAndNotify(synced);
    return synced;
  } catch (err) {
    const structuredError = toStructuredError(err);
    const attempts = entry.attempts + 1;

    if (structuredError.retryable) {
      const requeued = {
        ...entry,
        state: "queued",
        attempts,
        last_error: structuredError,
      };
      await persistAndNotify(requeued);
      scheduleRetry(requeued);
      return requeued;
    }

    const failed = {
      ...entry,
      state: "failed",
      attempts,
      last_error: structuredError,
    };
    await persistAndNotify(failed);
    return failed;
  }
}

/** FIFO order: enqueued_at, then seq as a tiebreaker for same-millisecond entries. */
function byFifoOrder(a, b) {
  if (a.enqueued_at !== b.enqueued_at) return a.enqueued_at - b.enqueued_at;
  return a.seq - b.seq;
}

/**
 * @param {Set<string>} excludeClientIds entries already attempted in the
 *   current flush pass — see flush()'s "attempt each entry at most once per
 *   pass" note below.
 */
async function nextQueuedEntry(excludeClientIds) {
  const all = await getAllEntries();
  const queued = all
    .filter((e) => e.state === "queued" && !excludeClientIds.has(e.client_id))
    .sort(byFifoOrder);
  return queued[0] ?? null;
}

/**
 * Drains the queue: dispatches every 'queued' entry, one at a time, in FIFO
 * order (by enqueued_at) — sequential, never parallel, so a flaky
 * connection can't interleave partial replays (design doc §3.2/§3.4). The
 * FIFO snapshot is re-read on every iteration, so entries enqueued *while*
 * a flush is running are picked up in order too.
 *
 * Each entry is attempted **at most once per flush() pass**. A retryable
 * failure puts the entry back to 'queued' immediately (so it's eligible
 * again on the *next* flush), but this pass won't immediately re-dispatch
 * it — otherwise a persistently-failing entry would hot-loop flush()
 * forever instead of honoring "retry later" (design doc §3.4). "Later" is
 * either the next explicit flush() call (manual retry, onReconnect's
 * 'online' handler) or the capped-backoff timer scheduled in scheduleRetry()
 * for browser environments.
 *
 * Re-entrant-safe: calling flush() while a flush is already running does
 * not start a second loop — it returns the SAME in-flight promise, so
 * callers can always safely `await flush()` to know when the queue is
 * drained, without ever causing concurrent/duplicate dispatch.
 *
 * @returns {Promise<void>}
 */
export function flush() {
  if (flushPromise) return flushPromise;
  const attemptedThisPass = new Set();
  flushPromise = (async () => {
    let entry = await nextQueuedEntry(attemptedThisPass);
    while (entry) {
      attemptedThisPass.add(entry.client_id);
      await dispatchEntry(entry);
      entry = await nextQueuedEntry(attemptedThisPass);
    }
  })().finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

/**
 * Registers the reconnect handler: listens for the browser 'online' event
 * and triggers flush() when it fires. Guarded for non-browser environments
 * (Node/tests/SSR) — a no-op there, returning a no-op unsubscribe.
 *
 * Call once at app startup (see /apps/outlet/src/App.jsx).
 *
 * @returns {() => void} unsubscribe function
 */
export function onReconnect() {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }
  const handler = () => {
    flush().catch(() => {});
  };
  window.addEventListener("online", handler);
  return () => window.removeEventListener("online", handler);
}

/**
 * Re-dispatches a single entry after user resolution of a 'failed' entry
 * (design doc §3.4's "needs human resolution" flow). Reuses the SAME
 * client_id — never regenerated — so the server's idempotency check still
 * applies correctly even if a prior attempt secretly landed.
 *
 * @param {string} clientId
 * @param {unknown} [updatedPayload] optional edited payload; same client_id.
 * @returns {Promise<import('./types').QueueEntry>}
 */
export async function retryEntry(clientId, updatedPayload) {
  const existing = await getEntry(clientId);
  if (!existing) {
    throw new Error(`offline-queue.retryEntry: no entry found for client_id "${clientId}"`);
  }

  const requeued = {
    ...existing,
    payload: updatedPayload !== undefined ? updatedPayload : existing.payload,
    state: "queued",
    last_error: null,
  };
  await persistAndNotify(requeued);
  await flush();
  return getEntry(clientId);
}

/**
 * Explicit user abandonment of a failed entry. Marked 'discarded' rather
 * than hard-deleted — keeps the record for audit — and excluded from all
 * future dispatch/flush.
 *
 * @param {string} clientId
 * @returns {Promise<import('./types').QueueEntry>}
 */
export async function discardEntry(clientId) {
  const existing = await getEntry(clientId);
  if (!existing) {
    throw new Error(`offline-queue.discardEntry: no entry found for client_id "${clientId}"`);
  }
  clearScheduledRetry(clientId);
  const discarded = { ...existing, state: "discarded" };
  await persistAndNotify(discarded);
  return discarded;
}

/**
 * Reads the current queue snapshot: counts by state + every entry, any
 * state. Used by useSyncStatus to render SyncBanner's "N items syncing" /
 * "sync failed" states without owning retry logic itself.
 *
 * @returns {Promise<import('./types').QueueSnapshot>}
 */
export async function getQueueSnapshot() {
  const entries = (await getAllEntries()).sort(byFifoOrder);
  /** @type {import('./types').QueueSnapshot['counts']} */
  const counts = { queued: 0, syncing: 0, synced: 0, failed: 0, discarded: 0 };
  for (const entry of entries) {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
  }
  return { counts, entries };
}

/**
 * Subscribes to queue state changes — fired with the full, fresh snapshot
 * on every state transition (enqueue, dispatch start/end, retry, discard).
 * No polling required.
 *
 * @param {import('./types').QueueSnapshotListener} listener
 * @returns {() => void} unsubscribe function
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
