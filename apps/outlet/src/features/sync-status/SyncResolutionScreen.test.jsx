import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SyncResolutionScreen from "./SyncResolutionScreen.jsx";

// Adjoa QA bug #2: SyncBanner rendered "N item(s) failed to sync — resolve
// needed" but nothing ever called retryEntry()/discardEntry(). This suite
// exercises the screen that now does — mocking @ub/offline-queue at the
// same boundary SyncBanner.test.jsx does (useSyncStatus -> getQueueSnapshot
// / subscribe), plus the two actions this screen adds.
let snapshot = { counts: {}, entries: [] };
const retryEntryMock = vi.fn();
const discardEntryMock = vi.fn();

vi.mock("@ub/offline-queue", () => ({
  getQueueSnapshot: () => Promise.resolve(snapshot),
  subscribe: () => () => {},
  retryEntry: (...args) => retryEntryMock(...args),
  discardEntry: (...args) => discardEntryMock(...args),
}));

// The screen now also resolves INSUFFICIENT_STOCK by recording the stock the
// shelf actually held and resending the sale, so it needs the outlet, the
// catalog (for names), current levels (for the shortfall) and the adjustment
// submitter. All mocked at the hook boundary, same as elsewhere in this app.
vi.mock("../../auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    profile: { id: "u1", role: "outlet_manager", outlet_id: "outlet-1" },
  }),
}));

let mockProducts = [];
vi.mock("../pos/useProducts.js", () => ({
  useProducts: () => ({ products: mockProducts, loading: false, error: null }),
}));

let mockLevels = [];
const refetchLevelsMock = vi.fn();
vi.mock("../stock/useStockLevels.js", () => ({
  useStockLevels: () => ({
    levels: mockLevels,
    loading: false,
    error: null,
    refetch: refetchLevelsMock,
  }),
}));

const submitAdjustmentMock = vi.fn();
vi.mock("../stock/useSubmitAdjustment.js", () => ({
  useSubmitAdjustment: () => ({
    submitAdjustment: (...args) => submitAdjustmentMock(...args),
    status: "idle",
    error: null,
  }),
}));

function setSnapshot(entries) {
  const counts = {
    queued: 0,
    syncing: 0,
    synced: 0,
    failed: entries.filter((e) => e.state === "failed").length,
    discarded: 0,
    blocked_identity_mismatch: 0,
  };
  snapshot = { counts, entries };
}

beforeEach(() => {
  mockProducts = [];
  mockLevels = [];
  submitAdjustmentMock.mockReset();
  submitAdjustmentMock.mockResolvedValue(undefined);
  refetchLevelsMock.mockReset();
  setSnapshot([]);
  retryEntryMock.mockReset().mockResolvedValue({});
  discardEntryMock.mockReset().mockResolvedValue({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("SyncResolutionScreen", () => {
  it("shows a calm empty state when nothing has failed", async () => {
    render(<SyncResolutionScreen />);
    expect(await screen.findByText(/nothing needs your attention/i)).toBeTruthy();
  });

  it("lists each failed entry with its stored error message and code", async () => {
    setSnapshot([
      {
        client_id: "a",
        type: "sale",
        state: "failed",
        last_error: { code: "INSUFFICIENT_STOCK", message: "Not enough stock for this item.", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);

    expect(await screen.findByText(/not enough stock for this item/i)).toBeTruthy();
    expect(screen.getByText(/INSUFFICIENT_STOCK/i)).toBeTruthy();
    expect(screen.getByText(/^Sale$/i)).toBeTruthy();
  });

  it("Retry calls offline-queue.retryEntry with the SAME client_id — never a new one", async () => {
    setSnapshot([
      {
        client_id: "sale-123",
        type: "sale",
        state: "failed",
        last_error: { code: "PRODUCT_NOT_FOUND", message: "This product no longer exists.", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const retryButton = await screen.findByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);

    await vi.waitFor(() => expect(retryEntryMock).toHaveBeenCalledWith("sale-123"));
  });

  it("Discard asks for confirmation, then calls offline-queue.discardEntry", async () => {
    setSnapshot([
      {
        client_id: "sale-456",
        type: "stock_adjustment",
        state: "failed",
        last_error: { code: "PRODUCT_NOT_FOUND", message: "This product no longer exists.", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const discardButton = await screen.findByRole("button", { name: /discard/i });
    fireEvent.click(discardButton);

    expect(window.confirm).toHaveBeenCalled();
    await vi.waitFor(() => expect(discardEntryMock).toHaveBeenCalledWith("sale-456"));
  });

  it("Discard does nothing if the user cancels the confirmation", async () => {
    window.confirm.mockReturnValue(false);
    setSnapshot([
      {
        client_id: "sale-789",
        type: "expense",
        state: "failed",
        last_error: { code: "X", message: "rejected", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const discardButton = await screen.findByRole("button", { name: /discard/i });
    fireEvent.click(discardButton);

    expect(discardEntryMock).not.toHaveBeenCalled();
  });

  it("surfaces a plain error if retryEntry itself rejects, without crashing", async () => {
    retryEntryMock.mockRejectedValue(new Error("still offline"));
    setSnapshot([
      {
        client_id: "sale-999",
        type: "sale",
        state: "failed",
        last_error: { code: "X", message: "rejected", retryable: false },
      },
    ]);

    render(<SyncResolutionScreen />);
    const retryButton = await screen.findByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);

    expect(await screen.findByText(/still offline/i)).toBeTruthy();
  });

  it("falls back to a generic explanation when an entry has no stored last_error", async () => {
    setSnapshot([{ client_id: "a", type: "sale", state: "failed", last_error: null }]);
    render(<SyncResolutionScreen />);
    expect(await screen.findByText(/rejected and needs your attention/i)).toBeTruthy();
  });

  it("says plainly that editing before retry isn't supported yet", async () => {
    setSnapshot([
      { client_id: "a", type: "sale", state: "failed", last_error: { code: "X", message: "x", retryable: false } },
    ]);
    render(<SyncResolutionScreen />);
    expect(await screen.findByText(/editing an entry's details before retrying isn't supported yet/i)).toBeTruthy();
  });
});

describe("SyncResolutionScreen — INSUFFICIENT_STOCK", () => {
  // Plain Retry is useless here (the server returned retryable:false and will
  // reject an identical resend forever) and Discard throws away a sale where
  // money changed hands. This is the third option.
  const shortfallEntry = {
    client_id: "cid-sale-1",
    type: "sale",
    state: "failed",
    payload: {
      client_id: "cid-sale-1",
      outlet_id: "outlet-1",
      line_items: [{ product_id: "p-milo", quantity: 5, submitted_unit_price: "45.00" }],
    },
    last_error: {
      code: "INSUFFICIENT_STOCK",
      message: "Insufficient stock for product p-milo: requested 5, available 3",
      retryable: false,
    },
  };

  const withStock = (qty) => {
    mockLevels = [{ product_id: "p-milo", product_name: "Milo 400g", quantity: qty }];
    mockProducts = [{ id: "p-milo", name: "Milo 400g", unit_price: "45.00" }];
  };

  it("offers to record the stock and resend", async () => {
    withStock(3);
    setSnapshot([shortfallEntry]);
    render(<SyncResolutionScreen />);

    expect(
      await screen.findByRole("button", { name: /record stock and resend/i })
    ).toBeTruthy();
  });

  it("shows the exact correction before applying it", async () => {
    // It asserts stock existed that the system never saw. Nobody should sign
    // that without seeing the numbers.
    withStock(3);
    setSnapshot([shortfallEntry]);
    render(<SyncResolutionScreen />);

    await screen.findByText(/Milo 400g/);
    // The three numbers a manager needs to judge it: sold, on record, and the
    // correction that would be written in their name.
    expect(screen.getByText(/sold 5, records/)).toBeTruthy();
    expect(screen.getByText(/showed 3/)).toBeTruthy();
    expect(screen.getByText(/\+2/)).toBeTruthy();
    expect(screen.getByText(/Only do it if the stock was genuinely there/i)).toBeTruthy();
  });

  it("records ONLY the shortfall, not the whole sold quantity", async () => {
    // Topping up by 5 would invent two units that never existed.
    withStock(3);
    setSnapshot([shortfallEntry]);
    render(<SyncResolutionScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /record stock and resend/i }));

    await vi.waitFor(() => expect(submitAdjustmentMock).toHaveBeenCalledTimes(1));
    expect(submitAdjustmentMock).toHaveBeenCalledWith({
      productId: "p-milo",
      outletId: "outlet-1",
      delta: 2,
      reason: "adjustment",
    });
  });

  it("resends the original sale afterwards, with its original client_id", async () => {
    withStock(3);
    setSnapshot([shortfallEntry]);
    render(<SyncResolutionScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /record stock and resend/i }));

    await vi.waitFor(() => expect(retryEntryMock).toHaveBeenCalledWith("cid-sale-1"));
  });

  it("does not resend if recording the stock fails", async () => {
    // Otherwise the sale is rejected again and the manager is told nothing
    // useful about why.
    withStock(3);
    submitAdjustmentMock.mockRejectedValue(new Error("offline"));
    setSnapshot([shortfallEntry]);
    render(<SyncResolutionScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /record stock and resend/i }));

    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(retryEntryMock).not.toHaveBeenCalled();
  });

  it("says Retry will work when stock already covers the sale", async () => {
    // Someone restocked since the rejection — no correction is needed and
    // offering one would inflate inventory.
    withStock(50);
    setSnapshot([shortfallEntry]);
    render(<SyncResolutionScreen />);

    expect(await screen.findByText(/Stock now covers this sale/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record stock and resend/i })).toBeNull();
  });

  it("does not offer the correction for other failure codes", async () => {
    setSnapshot([
      {
        ...shortfallEntry,
        last_error: { code: "PRODUCT_NOT_FOUND", message: "gone", retryable: false },
      },
    ]);
    render(<SyncResolutionScreen />);

    await screen.findByText(/gone/);
    expect(screen.queryByRole("button", { name: /record stock and resend/i })).toBeNull();
  });

  it("does not offer it for a non-sale entry", async () => {
    setSnapshot([
      {
        ...shortfallEntry,
        type: "stock_adjustment",
        payload: { product_id: "p-milo", delta: -5 },
      },
    ]);
    render(<SyncResolutionScreen />);

    await screen.findByText(/Insufficient stock/);
    expect(screen.queryByRole("button", { name: /record stock and resend/i })).toBeNull();
  });
});
