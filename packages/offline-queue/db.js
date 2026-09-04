/**
 * Small promise-based wrapper over IndexedDB — the local persistence layer
 * for the offline queue. No heavyweight dependency (no `idb`); this is
 * intentionally hand-rolled and scoped to exactly what the queue needs: one
 * object store, keyed by `client_id`, with get/getAll/put.
 *
 * See ultimate-bookkeeping-v2-design.md §3.2 — the write ("persist the
 * intent") has to land here before anything else happens, so every mutating
 * function in this file goes through a single `readwrite` transaction that
 * is awaited to `oncomplete` (not just the individual request's
 * `onsuccess`) before resolving, so callers can rely on durability.
 */

const DB_NAME = "ub-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "queue_entries";

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function getIndexedDB() {
  const idb = typeof globalThis !== "undefined" ? globalThis.indexedDB : undefined;
  if (!idb) {
    throw new Error(
      "offline-queue: IndexedDB is not available in this environment. " +
        "In tests, import 'fake-indexeddb/auto' before importing this module."
    );
  }
  return idb;
}

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const idb = getIndexedDB();
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "client_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** @param {IDBRequest} req */
function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {IDBTransaction} tx */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("offline-queue: transaction aborted"));
  });
}

/**
 * Persists (inserts or overwrites) a single entry, keyed by client_id.
 * @param {import('./types').QueueEntry} entry
 * @returns {Promise<import('./types').QueueEntry>}
 */
export async function putEntry(entry) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(entry);
  await txDone(tx);
  return entry;
}

/**
 * @param {string} clientId
 * @returns {Promise<import('./types').QueueEntry | null>}
 */
export async function getEntry(clientId) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const result = await requestToPromise(tx.objectStore(STORE_NAME).get(clientId));
  await txDone(tx);
  return result ?? null;
}

/**
 * @returns {Promise<import('./types').QueueEntry[]>}
 */
export async function getAllEntries() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const result = await requestToPromise(tx.objectStore(STORE_NAME).getAll());
  await txDone(tx);
  return result ?? [];
}

/**
 * Deletes a batch of entries by client_id, in a single readwrite
 * transaction. Used by retention pruning (index.js#pruneStaleEntries) — the
 * only caller that ever removes entries outright rather than transitioning
 * their state, and only ever for entries already confirmed 'synced' or
 * 'discarded' (never 'queued'/'syncing'/'failed'/'blocked_identity_mismatch').
 * @param {string[]} clientIds
 * @returns {Promise<void>}
 */
export async function deleteEntries(clientIds) {
  if (!clientIds || clientIds.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  for (const clientId of clientIds) {
    store.delete(clientId);
  }
  await txDone(tx);
}

/**
 * Test-only escape hatch: closes and forgets the cached DB handle and
 * deletes the underlying database so each test file starts from a clean
 * slate. Not used by app code.
 * @returns {Promise<void>}
 */
export async function _resetForTests() {
  const idb = getIndexedDB();
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // ignore — DB may already be broken/closed
    }
  }
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = idb.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(undefined);
  });
}
