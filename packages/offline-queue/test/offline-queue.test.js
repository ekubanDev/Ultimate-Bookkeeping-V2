import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postSaleMock = vi.fn();
const postStockAdjustmentMock = vi.fn();
const postExpenseMock = vi.fn();

vi.mock("@ub/api-client", async () => {
  const actual = await vi.importActual("@ub/api-client");
  return {
    ...actual,
    postSale: (...args) => postSaleMock(...args),
    postStockAdjustment: (...args) => postStockAdjustmentMock(...args),
    postExpense: (...args) => postExpenseMock(...args),
  };
});

const { ApiClientError } = await vi.importActual("@ub/api-client");
const { _resetForTests, getEntry } = await import("../db.js");
const { generateClientId } = await import("../idempotency.js");
const {
  enqueue,
  flush,
  retryEntry,
  discardEntry,
  getQueueSnapshot,
  subscribe,
} = await import("../index.js");

/** @returns {{client_id: string, type: 'sale', payload: object}} */
function buildSaleIntent(clientId, overrides = {}) {
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
      ...overrides,
    },
  };
}

function saleResponse(clientId, replay = false) {
  return {
    id: `srv-${clientId}`,
    client_id: clientId,
    status: "completed",
    total_amount: "10.00",
    created_at: new Date().toISOString(),
    idempotent_replay: replay,
  };
}

function retryableError() {
  return new ApiClientError({ code: "TRANSIENT", message: "try again", retryable: true }, 503);
}

function nonRetryableError() {
  return new ApiClientError(
    { code: "INSUFFICIENT_STOCK", message: "no stock", retryable: false },
    409
  );
}

beforeEach(async () => {
  postSaleMock.mockReset();
  postStockAdjustmentMock.mockReset();
  postExpenseMock.mockReset();
  await _resetForTests();
});

afterEach(async () => {
  // Make sure nothing is left mid-flight between tests.
  await flush();
});

describe("enqueue", () => {
  it("persists before any network attempt, and a dispatch failure leaves the entry queued", async () => {
    const clientId = generateClientId();
    let entrySeenAtDispatchTime = null;

    postSaleMock.mockImplementation(async (payload) => {
      entrySeenAtDispatchTime = await getEntry(payload.client_id);
      throw new TypeError("network down");
    });

    const entry = await enqueue(buildSaleIntent(clientId));
    expect(entry.state).toBe("queued");

    // The write must have landed in IndexedDB immediately — verifiable even
    // before we force the background dispatch to finish.
    const persistedImmediately = await getEntry(clientId);
    expect(persistedImmediately).not.toBeNull();
    expect(persistedImmediately.state).toBe("queued");

    await flush();

    expect(entrySeenAtDispatchTime).not.toBeNull();
    expect(entrySeenAtDispatchTime.client_id).toBe(clientId);

    const after = await getEntry(clientId);
    expect(after.state).toBe("queued");
    expect(after.attempts).toBe(1);
    expect(after.last_error).toEqual({
      code: "NETWORK_ERROR",
      message: "network down",
      retryable: true,
    });
  });

  it("rejects unknown intent types before touching the network", async () => {
    await expect(
      enqueue({ client_id: generateClientId(), type: "not-a-real-type", payload: {} })
    ).rejects.toThrow(/unknown intent type/);
    expect(postSaleMock).not.toHaveBeenCalled();
  });
});

describe("flush", () => {
  it("replays entries in FIFO order by enqueued_at, not insertion order", async () => {
    const idA = generateClientId();
    const idB = generateClientId();
    const idC = generateClientId();

    postSaleMock.mockImplementation(async (payload) => saleResponse(payload.client_id));

    // Seed directly via the db layer (simulating a relaunch replaying a
    // pre-existing queue) in a deliberately scrambled insertion order, but
    // with enqueued_at timestamps that define the "real" FIFO order A,B,C.
    const { putEntry } = await import("../db.js");
    const base = Date.now();
    await putEntry({
      client_id: idC,
      type: "sale",
      payload: buildSaleIntent(idC).payload,
      state: "queued",
      attempts: 0,
      last_error: null,
      enqueued_at: base + 20,
      synced_at: null,
      seq: 3,
    });
    await putEntry({
      client_id: idA,
      type: "sale",
      payload: buildSaleIntent(idA).payload,
      state: "queued",
      attempts: 0,
      last_error: null,
      enqueued_at: base,
      synced_at: null,
      seq: 1,
    });
    await putEntry({
      client_id: idB,
      type: "sale",
      payload: buildSaleIntent(idB).payload,
      state: "queued",
      attempts: 0,
      last_error: null,
      enqueued_at: base + 10,
      synced_at: null,
      seq: 2,
    });

    await flush();

    const callOrder = postSaleMock.mock.calls.map(([payload]) => payload.client_id);
    expect(callOrder).toEqual([idA, idB, idC]);
  });

  it("dispatches sequentially, never in parallel", async () => {
    const idA = generateClientId();
    const idB = generateClientId();

    const callOrder = [];
    const resolvers = [];
    postSaleMock.mockImplementation(
      (payload) =>
        new Promise((resolve) => {
          callOrder.push(payload.client_id);
          resolvers.push(() => resolve(saleResponse(payload.client_id)));
        })
    );

    await enqueue(buildSaleIntent(idA));
    await enqueue(buildSaleIntent(idB));

    const flushDone = flush();

    // Only the first entry should have started dispatch — the second must
    // not be called until the first's promise resolves.
    await vi.waitFor(() => expect(callOrder).toEqual([idA]));
    // give any (incorrect) parallel dispatch a chance to sneak in
    await new Promise((r) => setTimeout(r, 10));
    expect(callOrder).toEqual([idA]);

    resolvers[0]();
    await vi.waitFor(() => expect(callOrder).toEqual([idA, idB]));

    resolvers[1]();
    await flushDone;

    expect((await getEntry(idA)).state).toBe("synced");
    expect((await getEntry(idB)).state).toBe("synced");
  });

  it("is re-entrant-safe: a flush while one is running is a no-op (same in-flight promise)", async () => {
    const clientId = generateClientId();
    postSaleMock.mockImplementation(async (payload) => saleResponse(payload.client_id));

    await enqueue(buildSaleIntent(clientId));

    const first = flush();
    const second = flush();
    expect(second).toBe(first);

    await first;
    // No duplicate dispatch happened.
    expect(postSaleMock).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch outcomes", () => {
  it("idempotent_replay: true is treated as plain success -> synced", async () => {
    const clientId = generateClientId();
    postSaleMock.mockResolvedValueOnce(saleResponse(clientId, /* replay */ true));

    await enqueue(buildSaleIntent(clientId));
    await flush();

    const entry = await getEntry(clientId);
    expect(entry.state).toBe("synced");
    expect(entry.synced_at).not.toBeNull();
  });

  it("retryable:false -> failed, and subsequent flushes make no further attempts", async () => {
    const clientId = generateClientId();
    postSaleMock.mockRejectedValueOnce(nonRetryableError());

    await enqueue(buildSaleIntent(clientId));
    await flush();

    let entry = await getEntry(clientId);
    expect(entry.state).toBe("failed");
    expect(entry.attempts).toBe(1);
    expect(entry.last_error).toEqual({
      code: "INSUFFICIENT_STOCK",
      message: "no stock",
      retryable: false,
    });

    postSaleMock.mockClear();
    await flush();
    await flush();

    expect(postSaleMock).not.toHaveBeenCalled();
    entry = await getEntry(clientId);
    expect(entry.state).toBe("failed");
    expect(entry.attempts).toBe(1);
  });

  it("retryable:true / network error stays queued and is retried on the next flush, same client_id throughout", async () => {
    const clientId = generateClientId();
    postSaleMock
      .mockRejectedValueOnce(retryableError())
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(saleResponse(clientId));

    await enqueue(buildSaleIntent(clientId));
    await flush();
    let entry = await getEntry(clientId);
    expect(entry.state).toBe("queued");
    expect(entry.attempts).toBe(1);
    expect(entry.client_id).toBe(clientId);

    await flush();
    entry = await getEntry(clientId);
    expect(entry.state).toBe("queued");
    expect(entry.attempts).toBe(2);
    expect(entry.client_id).toBe(clientId);

    await flush();
    entry = await getEntry(clientId);
    expect(entry.state).toBe("synced");
    expect(entry.attempts).toBe(3);
    expect(entry.client_id).toBe(clientId);

    expect(postSaleMock).toHaveBeenCalledTimes(3);
    for (const [payload] of postSaleMock.mock.calls) {
      expect(payload.client_id).toBe(clientId);
    }
  });
});

describe("retryEntry / discardEntry", () => {
  it("retryEntry moves a failed entry to synced on success", async () => {
    const clientId = generateClientId();
    postSaleMock.mockRejectedValueOnce(nonRetryableError());

    await enqueue(buildSaleIntent(clientId));
    await flush();
    expect((await getEntry(clientId)).state).toBe("failed");

    postSaleMock.mockResolvedValueOnce(saleResponse(clientId));
    const result = await retryEntry(clientId);

    expect(result.state).toBe("synced");
    expect(result.client_id).toBe(clientId);
    expect((await getEntry(clientId)).state).toBe("synced");
  });

  it("retryEntry accepts an edited payload but keeps the same client_id", async () => {
    const clientId = generateClientId();
    postSaleMock.mockRejectedValueOnce(nonRetryableError());
    await enqueue(buildSaleIntent(clientId));
    await flush();

    postSaleMock.mockResolvedValueOnce(saleResponse(clientId));
    const editedPayload = { ...buildSaleIntent(clientId).payload, tax_amount: "5.00" };
    await retryEntry(clientId, editedPayload);

    expect(postSaleMock).toHaveBeenLastCalledWith(editedPayload);
    const entry = await getEntry(clientId);
    expect(entry.client_id).toBe(clientId);
    expect(entry.payload.tax_amount).toBe("5.00");
  });

  it("discardEntry marks the entry 'discarded' rather than deleting it", async () => {
    const clientId = generateClientId();
    postSaleMock.mockRejectedValueOnce(nonRetryableError());
    await enqueue(buildSaleIntent(clientId));
    await flush();

    const discarded = await discardEntry(clientId);
    expect(discarded.state).toBe("discarded");

    const stillThere = await getEntry(clientId);
    expect(stillThere).not.toBeNull();
    expect(stillThere.state).toBe("discarded");

    // Discarded entries are never picked up by flush again.
    postSaleMock.mockClear();
    await flush();
    expect(postSaleMock).not.toHaveBeenCalled();
  });
});

describe("getQueueSnapshot / subscribe", () => {
  it("reports correct counts through a full mixed lifecycle", async () => {
    const idSynced = generateClientId();
    const idQueued = generateClientId();
    const idDiscarded = generateClientId();

    const routing = {
      [idSynced]: "success",
      [idQueued]: "retryable",
      [idDiscarded]: "nonretryable",
    };
    postSaleMock.mockImplementation(async (payload) => {
      const behavior = routing[payload.client_id];
      if (behavior === "success") return saleResponse(payload.client_id);
      if (behavior === "retryable") throw retryableError();
      throw nonRetryableError();
    });

    await enqueue(buildSaleIntent(idSynced));
    await enqueue(buildSaleIntent(idQueued));
    await enqueue(buildSaleIntent(idDiscarded));
    await flush();

    await discardEntry(idDiscarded);

    const snapshot = await getQueueSnapshot();
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.counts.synced).toBe(1);
    expect(snapshot.counts.queued).toBe(1);
    expect(snapshot.counts.discarded).toBe(1);
    expect(snapshot.counts.failed).toBe(0);
    expect(snapshot.counts.syncing).toBe(0);
  });

  it("notifies subscribers with a fresh snapshot on every state transition", async () => {
    const clientId = generateClientId();
    postSaleMock.mockResolvedValueOnce(saleResponse(clientId));

    const seenStates = [];
    const unsubscribe = subscribe((snapshot) => {
      const entry = snapshot.entries.find((e) => e.client_id === clientId);
      if (entry) seenStates.push(entry.state);
    });

    try {
      await enqueue(buildSaleIntent(clientId));
      await flush();
    } finally {
      unsubscribe();
    }

    // Should have observed at least the queued -> syncing -> synced transitions.
    expect(seenStates).toContain("queued");
    expect(seenStates).toContain("syncing");
    expect(seenStates[seenStates.length - 1]).toBe("synced");
  });
});
