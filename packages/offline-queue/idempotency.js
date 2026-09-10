/**
 * Idempotency key generation for offline-eligible intents (sales, stock
 * adjustments, expenses). See ultimate-bookkeeping-v2-design.md §3.3.
 *
 * The key contract: `client_id` is generated exactly ONCE, at the moment an
 * intent is created on-device, and is never regenerated on retry. Every
 * `useSubmit*` hook must call `generateClientId()` a single time per intent
 * and reuse that same value across all retry/replay attempts — that's what
 * lets the server's UNIQUE(client_id) constraint collapse duplicate
 * submissions into a single idempotent replay instead of a duplicate row.
 */

/**
 * Generates a fresh idempotency key for a new offline-eligible intent.
 * Call this once per intent, at creation time — never on retry.
 *
 * @returns {string} a UUID (v4, via crypto.randomUUID())
 */
export function generateClientId() {
  return crypto.randomUUID();
}
