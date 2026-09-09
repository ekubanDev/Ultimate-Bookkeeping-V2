/**
 * Tests for Adjoa QA #6: IndexedDB quota exhaustion was previously
 * unhandled — `putEntry` had no handling for `QuotaExceededError`, so on a
 * full disk `enqueue()` rejected with no queue entry ever persisted (no
 * `client_id`, no record) and the caller had no way to distinguish that
 * from any other failure.
 *
 * Covers:
 *  - db.js#isQuotaExceededError recognizes every quota-error shape browsers
 *    are known to use (modern DOMException name, legacy WebKit numeric
 *    code, old Firefox numeric code) and nothing else.
 *  - db.js#putEntry wraps a quota failure into `QuotaExceededStorageError`,
 *    and leaves any other error untouched.
 *  - index.js#persistAndNotify's emergency-prune-and-retry: a quota failure
 *    triggers an immediate prune of terminal (synced/discarded) entries and
 *    exactly one retry; a genuinely full disk (nothing prunable, or still
 *    full after pruning) fails cleanly — never loops, never touches
 *    unsynced ('queued'/'syncing'/'failed'/'blocked_identity_mismatch')
 *    entries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postSaleMock = vi.fn();
vi.mock("@ub/api-client", async () => {
  const actual = await vi.importActual("@ub/api-client");
  return {
    ...actual,
    postSale: (...args) => postSaleMock(...args),
  };
});

const {
  _resetForTests,
  getEntry,
  putEntry,
  isQuotaExceededError,
  QuotaExceededStorageError,
} = await import("../db.js");
const { generateClientId } = await import("../idempotency.js");
const { enqueue, getQueueSnapshot, setCurrentUserProvider, flush } = await import("../index.js");

function buildSaleIntent(clientId) {
  return {
    client_id: clientId,
    type: "sale",
    payload: {
      client_id: clientId,
      outlet_id: "outlet-1",
      line_items: [{ product_id: "prod-1", quantity: 1, unit_price: "10.00" }],
      payment_method: "cash",
      discount_amount: "0.00",
      tax_amount: "0.00",
      device_recorded_at: new Date().toISOString(),
    },
  };
}

let seedSeq = 9000;
/** Seeds a terminal (synced) entry directly via the real db.js, prunable by an emergency prune. */
function seedSyncedEntry(clientId, synced_at) {
  return putEntry({
    client_id: clientId,
    type: "sale",
    payload: buildSaleIntent(clientId).payload,
    state: "synced",
    attempts: 1,
    last_error: null,
    enqueued_at: Date.now() - 1000,
    synced_at,
    discarded_at: null,
    last_response: null,
    created_by: null,
    seq: seedSeq++,
    syncing_since: null,
  });
}

beforeEach(async () => {
  postSaleMock.mockReset();
  postSaleMock.mockResolvedValue({
    id: "srv-x",
    status: "completed",
    total_amount: "10.00",
    created_at: new Date().toISOString(),
    idempotent_replay: false,
  });
  setCurrentUserProvider(() => Promise.resolve(undefined));
  await _resetForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setCurrentUserProvider(() => Promise.resolve(undefined));
  await flush().catch(() => {});
});

describe("isQuotaExceededError", () => {
  it("recognizes a modern DOMException named QuotaExceededError", () => {
    expect(isQuotaExceededError(new DOMException("full", "QuotaExceededError"))).toBe(true);
  });

  it("recognizes the legacy WebKit numeric code 22, even with no name", () => {
    expect(isQuotaExceededError({ code: 22 })).toBe(true);
  });

  it("recognizes old Firefox's NS_ERROR_DOM_QUOTA_REACHED (name and/or numeric code 1014)", () => {
    expect(isQuotaExceededError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaExceededError({ code: 1014 })).toBe(true);
  });

  it("does not misidentify an unrelated error", () => {
    expect(isQuotaExceededError(new TypeError("network down"))).toBe(false);
    expect(isQuotaExceededError(new DOMException("blocked", "AbortError"))).toBe(false);
    expect(isQuotaExceededError({ code: 11 })).toBe(false);
  });

  it("is defensive against null/undefined/non-object input", () => {
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError(undefined)).toBe(false);
    expect(isQuotaExceededError("QuotaExceededError")).toBe(false);
  });
});

describe("db.js#putEntry — quota error wrapping", () => {
  it("wraps a quota-shaped failure from the underlying store into QuotaExceededStorageError, preserving the cause", async () => {
    // Force open the real DB so the spy below intercepts the actual write
    // path putEntry uses.
    await getEntry("warm-up");
    const original = globalThis.IDBObjectStore.prototype.put;
    const quotaErr = new DOMException("disk full", "QuotaExceededError");
    const spy = vi
      .spyOn(globalThis.IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw quotaErr;
      });

    try {
      const clientId = generateClientId();
      await expect(
        putEntry({
          client_id: clientId,
          type: "sale",
          payload: buildSaleIntent(clientId).payload,
          state: "queued",
          attempts: 0,
          last_error: null,
          enqueued_at: Date.now(),
          synced_at: null,
          discarded_at: null,
          last_response: null,
          created_by: null,
          seq: 1,
          syncing_since: null,
        })
      ).rejects.toMatchObject({
        name: "QuotaExceededStorageError",
        cause: quotaErr,
      });
      expect(await getEntry(clientId)).toBeNull();
    } finally {
      spy.mockRestore();
      expect(globalThis.IDBObjectStore.prototype.put).toBe(original);
    }
  });

  it("leaves a non-quota error from the store untouched (no false-positive wrapping)", async () => {
    await getEntry("warm-up");
    const boringErr = new Error("some other IndexedDB failure");
    const spy = vi
      .spyOn(globalThis.IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw boringErr;
      });

    try {
      const clientId = generateClientId();
      await expect(
        putEntry({
          client_id: clientId,
          type: "sale",
          payload: buildSaleIntent(clientId).payload,
          state: "queued",
          attempts: 0,
          last_error: null,
          enqueued_at: Date.now(),
          synced_at: null,
          discarded_at: null,
          last_response: null,
          created_by: null,
          seq: 2,
          syncing_since: null,
        })
      ).rejects.toBe(boringErr);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("index.js — emergency prune-and-retry on a full disk (enqueue)", () => {
  it("prunes terminal entries and retries once, turning a would-be-lost sale into a recorded one", async () => {
    const staleSyncedId = generateClientId();
    await seedSyncedEntry(staleSyncedId, Date.now() - 1000);

    const quotaErr = new DOMException("disk full", "QuotaExceededError");
    const spy = vi
      .spyOn(globalThis.IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw quotaErr;
      });

    const newClientId = generateClientId();
    let callCount;
    try {
      const entry = await enqueue(buildSaleIntent(newClientId));
      // The emergency prune-and-retry succeeded: the new sale IS durably
      // queued despite the first write attempt hitting quota.
      expect(entry.client_id).toBe(newClientId);
      expect(entry.state).toBe("queued");
    } finally {
      // Capture the call count BEFORE mockRestore() — mockRestore() clears
      // recorded call history (it's mockReset() + restoring the original
      // implementation), so asserting on `spy` after this point would
      // always see 0 regardless of what actually happened.
      callCount = spy.mock.calls.length;
      spy.mockRestore();
    }

    expect(await getEntry(newClientId)).not.toBeNull();
    // The old terminal entry was reclaimed to make room.
    expect(await getEntry(staleSyncedId)).toBeNull();
    // The failed first attempt, plus exactly one retry after pruning — never a loop.
    expect(callCount).toBe(2);
  });

  it("fails cleanly (not a loop) and records nothing when there is nothing safe to prune", async () => {
    const quotaErr = new DOMException("disk full", "QuotaExceededError");
    const spy = vi
      .spyOn(globalThis.IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw quotaErr;
      });

    const clientId = generateClientId();
    let callCount;
    try {
      await expect(enqueue(buildSaleIntent(clientId))).rejects.toMatchObject({
        name: "QuotaExceededStorageError",
      });
    } finally {
      callCount = spy.mock.calls.length;
      spy.mockRestore();
    }

    // Nothing was ever persisted for this sale — no client_id, no record.
    expect(await getEntry(clientId)).toBeNull();
    // Only the one attempt — no retry was warranted since prunedCount was 0.
    expect(callCount).toBe(1);
  });

  it("fails cleanly (exactly one retry, no loop) when the disk is still full even after pruning everything safe", async () => {
    const staleSyncedId = generateClientId();
    await seedSyncedEntry(staleSyncedId, Date.now() - 1000);

    const quotaErr = new DOMException("disk full", "QuotaExceededError");
    const spy = vi
      .spyOn(globalThis.IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw quotaErr;
      })
      .mockImplementationOnce(() => {
        throw quotaErr;
      });

    const clientId = generateClientId();
    let callCount;
    try {
      await expect(enqueue(buildSaleIntent(clientId))).rejects.toMatchObject({
        name: "QuotaExceededStorageError",
      });
    } finally {
      callCount = spy.mock.calls.length;
      spy.mockRestore();
    }

    // The prunable entry was still reclaimed even though the retry also failed...
    expect(await getEntry(staleSyncedId)).toBeNull();
    // ...but the new sale was never recorded, and only exactly two attempts
    // were made total (the original + the single retry) — never a third.
    expect(await getEntry(clientId)).toBeNull();
    expect(callCount).toBe(2);
  });

  it("never prunes unsynced (queued/syncing/failed/blocked_identity_mismatch) entries to make room", async () => {
    // A 'failed' entry — unsynced money — must never be pruned, even in an
    // emergency: losing recorded-but-unsynced money to save storage would
    // be strictly worse than the original problem.
    const failedId = generateClientId();
    await putEntry({
      client_id: failedId,
      type: "sale",
      payload: buildSaleIntent(failedId).payload,
      state: "failed",
      attempts: 1,
      last_error: { code: "X", message: "x", retryable: false },
      enqueued_at: Date.now() - 1000,
      synced_at: null,
      discarded_at: null,
      last_response: null,
      created_by: null,
      seq: seedSeq++,
      syncing_since: null,
    });

    const quotaErr = new DOMException("disk full", "QuotaExceededError");
    const spy = vi
      .spyOn(globalThis.IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw quotaErr;
      });

    const clientId = generateClientId();
    try {
      await expect(enqueue(buildSaleIntent(clientId))).rejects.toMatchObject({
        name: "QuotaExceededStorageError",
      });
    } finally {
      spy.mockRestore();
    }

    // The unsynced 'failed' entry survives untouched.
    const stillThere = await getEntry(failedId);
    expect(stillThere).not.toBeNull();
    expect(stillThere.state).toBe("failed");
  });
});
