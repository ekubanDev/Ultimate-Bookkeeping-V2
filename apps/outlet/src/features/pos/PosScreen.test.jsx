import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PosScreen from "./PosScreen.jsx";

// PosScreen -> useSubmitSale -> @ub/offline-queue.enqueue is the only
// side-effecting boundary this test needs to cross; everything else
// (cartReducer, buildSaleIntent) is real, exercised end to end. Per the
// task brief: "render PosScreen with mocked queue (mock @ub/offline-queue)".
const enqueueMock = vi.fn();
vi.mock("@ub/offline-queue", () => ({
  enqueue: (...args) => enqueueMock(...args),
  // useSubmitSale imports this to distinguish a full-disk enqueue() failure
  // from every other failure mode (Adjoa QA #6) — stub it as a real class so
  // `instanceof` checks work the same as against the real export.
  QuotaExceededStorageError: class QuotaExceededStorageError extends Error {},
}));

// PosScreen now reads outlet_id from useAuth().profile rather than a
// hardcoded placeholder — mock the auth context to a signed-in outlet
// manager so this test exercises the same shape a real AuthProvider would
// hand down, without pulling in Firebase/api-client.
vi.mock("../../auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    profile: { id: "user-1", role: "outlet_manager", outlet_id: "outlet-test-1", display_name: "Test Manager" },
    status: "signed_in",
  }),
}));

// PosScreen now sources the catalog from useProducts (GET /api/v1/products)
// rather than the retired DEMO_PRODUCTS placeholder — mock the fetch hook
// so this test exercises the same real-catalog shape without hitting
// api-client/fetch. Same product set as the old DEMO_PRODUCTS so the
// existing checkout-flow assertions below don't need to change.
const MOCK_PRODUCTS = [
  { id: "prod-demo-water", sku: null, name: "Sachet Water (bag)", unit_price: "5.00", min_stock: null },
  { id: "prod-demo-milo", sku: "MILO400", name: "Milo 400g", unit_price: "45.00", min_stock: 10 },
  { id: "prod-demo-kalyppo", sku: "KLYPPO", name: "Kalyppo Juice", unit_price: "8.50", min_stock: 5 },
  { id: "prod-demo-rice", sku: "RICE5", name: "Rice 5kg", unit_price: "75.00", min_stock: 3 },
  { id: "prod-demo-oil", sku: "OIL1L", name: "Frytol Oil 1L", unit_price: "38.00", min_stock: 5 },
  { id: "prod-demo-soap", sku: "KEYSOAP", name: "Key Soap", unit_price: "12.00", min_stock: 10 },
];

const useProductsMock = vi.fn();
vi.mock("./useProducts.js", () => ({
  useProducts: (...args) => useProductsMock(...args),
}));

// PosScreen now also reads live stock so it can warn before a cashier rings
// up something the books say is not there. Mocked so the warning path is
// actually exercised — without this the real hook's fetch simply fails, every
// product reads as `unknown`, and the tests pass by never reaching the code.
let mockStock = { levels: [], loading: false, error: null, refetch: () => {} };
vi.mock("../stock/useStockLevels.js", () => ({
  useStockLevels: () => mockStock,
}));

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ state: "queued", client_id: "mock-entry" });
  mockStock = { levels: [], loading: false, error: null, refetch: () => {} };
  useProductsMock.mockReset();
  useProductsMock.mockReturnValue({
    products: MOCK_PRODUCTS,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

describe("PosScreen — happy checkout path", () => {
  it("adds a product, checks out, enqueues a well-formed sale intent, and clears the cart", async () => {
    render(<PosScreen />);

    // Add one demo product to the cart via ProductGrid. "Sachet Water (bag)"
    // now appears twice: once in the ProductGrid tile, once in the new Cart
    // line item.
    fireEvent.click(screen.getByRole("button", { name: /Sachet Water \(bag\)/i }));
    expect(screen.getAllByText("Sachet Water (bag)")).toHaveLength(2);

    // Open checkout.
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));
    const confirmButton = await screen.findByRole("button", { name: /confirm sale/i });

    fireEvent.click(confirmButton);

    // enqueue() was called exactly once, with a well-formed sale intent.
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const [intent] = enqueueMock.mock.calls[0];

    expect(intent.type).toBe("sale");
    expect(typeof intent.client_id).toBe("string");
    expect(intent.client_id.length).toBeGreaterThan(0);
    expect(intent.payload.client_id).toBe(intent.client_id);
    expect(intent.payload.outlet_id).toBe("outlet-test-1");
    expect(intent.payload.payment_method).toBe("cash");
    // Default checkout state: no discount applied (percentage, 0.00%).
    expect(intent.payload.discount_type).toBe("percentage");
    expect(intent.payload.discount_value).toBe("0.00");
    expect(intent.payload.tax_amount).toBe("0.00");
    expect(intent.payload.line_items).toEqual([
      { product_id: "prod-demo-water", quantity: 1, submitted_unit_price: "5.00" },
    ]);
    expect(typeof intent.payload.device_recorded_at).toBe("string");

    // Cart cleared and checkout modal closed — enqueue resolving IS
    // "success" from the cashier's perspective (design doc §3.2).
    await screen.findByText("Cart is empty.");
    expect(screen.queryByRole("button", { name: /confirm sale/i })).toBeNull();
  });

  it("keeps the checkout modal open and shows the failed state when enqueue rejects", async () => {
    enqueueMock.mockReset();
    enqueueMock.mockRejectedValue(new Error("indexeddb unavailable"));

    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Milo 400g/i }));
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));
    const confirmButton = await screen.findByRole("button", { name: /confirm sale/i });

    fireEvent.click(confirmButton);

    await screen.findByText(/could not record this sale/i);
    // Cart is NOT cleared and the modal stays open on failure.
    expect(screen.queryByText("Cart is empty.")).toBeNull();
    expect(screen.getByRole("button", { name: /confirm sale/i })).toBeTruthy();
  });

  it("submits a percentage discount as discount_type/discount_value, not a money amount", async () => {
    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Rice 5kg/i }));
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));
    await screen.findByRole("button", { name: /confirm sale/i });

    // Percentage is the default type — just fill in a value.
    fireEvent.change(screen.getByLabelText(/discount value \(%\)/i), {
      target: { value: "10.00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const [intent] = enqueueMock.mock.calls[0];
    expect(intent.payload.discount_type).toBe("percentage");
    expect(intent.payload.discount_value).toBe("10.00");
  });

  it("submits a fixed discount as discount_type/discount_value after toggling the discount type", async () => {
    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Rice 5kg/i }));
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));
    await screen.findByRole("button", { name: /confirm sale/i });

    fireEvent.click(screen.getByRole("radio", { name: /fixed amount \(ghs\)/i }));
    fireEvent.change(screen.getByLabelText(/discount value \(ghs\)/i), {
      target: { value: "5.00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const [intent] = enqueueMock.mock.calls[0];
    expect(intent.payload.discount_type).toBe("fixed");
    expect(intent.payload.discount_value).toBe("5.00");
  });
});

describe("PosScreen — double-tap protection (Adjoa QA #5)", () => {
  // client_id is generated fresh inside submitSale on every call, and the
  // whole idempotency contract (design doc §3.3) rests on it being
  // generated exactly ONCE per intent. CheckoutModal's `canConfirm` only
  // gates on `status !== 'queued'` — a piece of React state that only
  // takes effect after a re-render. Nothing previously exercised the
  // real double-tap path end to end (real CheckoutModal + real
  // useSubmitSale, only @ub/offline-queue's enqueue mocked), so this test
  // fires two rapid, synchronous confirms — exactly what two fast taps on
  // a touchscreen deliver: two separate 'click' events in quick
  // succession, with no `await` (no yield to the microtask/event queue)
  // between them — and asserts enqueue() was called exactly once.
  it("firing two rapid confirms enqueues exactly once, not two duplicate sales", async () => {
    let resolveEnqueue;
    enqueueMock.mockReset();
    enqueueMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnqueue = resolve;
        })
    );

    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Milo 400g/i }));
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));
    const confirmButton = await screen.findByRole("button", { name: /confirm sale/i });

    // Two back-to-back taps, synchronously, with no await in between.
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    // The submission guard must hold WITHOUT relying on a second React
    // re-render having happened yet: exactly one intent was ever built and
    // handed to the offline queue.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(new Set(enqueueMock.mock.calls.map(([intent]) => intent.client_id)).size).toBe(1);

    // Let the in-flight enqueue() resolve so the test doesn't leak a
    // pending act() warning/unhandled state update into later tests.
    resolveEnqueue({ state: "queued", client_id: enqueueMock.mock.calls[0][0].client_id });
    await screen.findByText("Cart is empty.");
  });
});

describe("PosScreen — product catalog sourcing (useProducts)", () => {
  it("shows a loading message and no product tiles while the catalog fetch is in flight", () => {
    useProductsMock.mockReturnValue({
      products: [],
      loading: true,
      error: null,
      refetch: vi.fn(),
    });

    render(<PosScreen />);

    expect(screen.getByText(/loading products/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rice 5kg/i })).toBeNull();
  });

  it("shows a plain error message when the catalog fetch fails", () => {
    useProductsMock.mockReturnValue({
      products: [],
      loading: false,
      error: new Error("network error"),
      refetch: vi.fn(),
    });

    render(<PosScreen />);

    expect(screen.getByText(/could not load products/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rice 5kg/i })).toBeNull();
  });

  it("tells the manager plainly when the outlet has no products yet, rather than rendering an empty grid", () => {
    useProductsMock.mockReturnValue({
      products: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<PosScreen />);

    expect(screen.getByText(/no products yet/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rice 5kg/i })).toBeNull();
  });

  it("renders real catalog products from useProducts once loaded", () => {
    render(<PosScreen />);

    expect(screen.getByRole("button", { name: /Rice 5kg/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Milo 400g/i })).toBeTruthy();
    expect(screen.queryByText(/loading products/i)).toBeNull();
    expect(screen.queryByText(/could not load products/i)).toBeNull();
    expect(screen.queryByText(/no products yet/i)).toBeNull();
  });
});

describe("PosScreen — consecutive sales while offline", () => {
  // Regression cover for a bug found on the live deployment: offline, a
  // cashier could record exactly ONE sale. The second checkout opened with
  // the confirm button greyed out and labelled "Recording...", forever.
  //
  // Cause: enqueue() resolves with state 'queued' when there is no network
  // (it can never reach 'synced'), useSubmitSale stored that as its status,
  // and CheckoutModal's canConfirm gated on `status !== 'queued'`. So the
  // terminal SUCCESS state was being read as "still in flight".
  //
  // It hid online because dispatch usually completes fast enough that
  // enqueue() returns 'synced' — the two states were distinguishable only by
  // timing, which is exactly the condition that disappears offline. PosScreen
  // already treated queued as success (it clears the cart and closes the
  // modal on it); CheckoutModal disagreed.
  //
  // enqueueMock resolves { state: "queued" } by default (see beforeEach),
  // which IS the offline case, so this needs no extra setup.
  it("allows a second sale after the first one is queued offline", async () => {
    render(<PosScreen />);

    // --- first sale ---
    fireEvent.click(screen.getByRole("button", { name: /Milo 400g/i }));
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm sale/i }));

    await screen.findByRole("button", { name: /^checkout$/i });
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    // --- second sale: the button must be usable again ---
    fireEvent.click(screen.getByRole("button", { name: /Rice 5kg/i }));
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));

    const confirm = await screen.findByRole("button", { name: /confirm sale/i });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(enqueueMock).toHaveBeenCalledTimes(2);

    // Each sale carries its own client_id — the idempotency contract would be
    // broken if a reused intent were resubmitted under the same key.
    const ids = enqueueMock.mock.calls.map(([intent]) => intent.client_id);
    expect(new Set(ids).size).toBe(2);
  });

  it("shows 'Recording...' only while enqueue is actually in flight", async () => {
    let resolveEnqueue;
    enqueueMock.mockReset();
    enqueueMock.mockImplementation(
      () => new Promise((resolve) => { resolveEnqueue = resolve; })
    );

    render(<PosScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Milo 400g/i }));
    fireEvent.click(screen.getByRole("button", { name: /^checkout$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm sale/i }));

    // In flight: label changes and the button is blocked (double-tap guard).
    const recording = await screen.findByRole("button", { name: /recording/i });
    expect(recording.disabled).toBe(true);

    resolveEnqueue({ state: "queued", client_id: "entry-1" });
    await screen.findByRole("button", { name: /^checkout$/i });
  });
});

describe("PosScreen — product search", () => {
  // The pilot catalog is 213 products rendered as a flat grid. Without search,
  // finding one means scrolling past two hundred others with a customer
  // waiting, so these cover the narrowing itself and the states around it.
  const searchBox = () => screen.getByRole("searchbox", { name: /search products/i });

  it("shows every product before anything is typed", () => {
    render(<PosScreen />);
    // Each product renders one tile button; the cart is empty so no duplicates.
    expect(screen.getByRole("button", { name: /Milo 400g/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rice 5kg/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Key Soap/ })).toBeTruthy();
  });

  it("narrows the grid to matching products as the cashier types", () => {
    render(<PosScreen />);

    fireEvent.change(searchBox(), { target: { value: "milo" } });

    expect(screen.getByRole("button", { name: /Milo 400g/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rice 5kg/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Key Soap/ })).toBeNull();
  });

  it("matches on SKU, not just the name", () => {
    render(<PosScreen />);

    fireEvent.change(searchBox(), { target: { value: "KEYSOAP" } });

    expect(screen.getByRole("button", { name: /Key Soap/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Milo 400g/ })).toBeNull();
  });

  it("reports how many of the catalog are showing, but only while searching", () => {
    render(<PosScreen />);
    expect(screen.queryByText(/of 6 products/)).toBeNull();

    fireEvent.change(searchBox(), { target: { value: "oil" } });

    expect(screen.getByText("1 of 6 products")).toBeTruthy();
  });

  it("says so when nothing matches, instead of showing a blank grid", () => {
    render(<PosScreen />);

    fireEvent.change(searchBox(), { target: { value: "bicycle" } });

    expect(screen.getByText(/No products match/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Milo 400g/ })).toBeNull();
  });

  it("restores the full grid when the query is cleared", () => {
    render(<PosScreen />);

    fireEvent.change(searchBox(), { target: { value: "milo" } });
    expect(screen.queryByRole("button", { name: /Rice 5kg/ })).toBeNull();

    fireEvent.change(searchBox(), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /Rice 5kg/ })).toBeTruthy();
  });

  it("still adds the right product to the cart after filtering", () => {
    // The tile must carry the real product through, not a filtered copy.
    render(<PosScreen />);

    fireEvent.change(searchBox(), { target: { value: "kalyppo" } });
    fireEvent.click(screen.getByRole("button", { name: /Kalyppo Juice/ }));

    // Now in the cart: the name AND the formatted price each appear twice,
    // once in the grid tile and once in the cart line.
    expect(screen.getAllByText("Kalyppo Juice").length).toBeGreaterThan(1);
    expect(screen.getAllByText("₵8.50").length).toBeGreaterThan(1);
  });
});

describe("PosScreen — selling something that is not in stock", () => {
  // The failure this prevents: the cashier rings up a sold-out item, the cart
  // clears, the customer leaves, and hours later the sale fails to sync with
  // INSUFFICIENT_STOCK (retryable: false) — money taken, sale unrecordable.
  const STOCKED = [
    { product_id: "prod-demo-milo", product_name: "Milo 400g", quantity: 12, sku: "MILO400" },
    { product_id: "prod-demo-rice", product_name: "Rice 5kg", quantity: 0, sku: "RICE5" },
    // prod-demo-water is deliberately absent: never stocked at this outlet.
  ];

  it("adds a well-stocked product straight to the cart, no friction", () => {
    mockStock = { levels: STOCKED, loading: false, error: null, refetch: () => {} };
    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Milo 400g/ }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByText("Milo 400g").length).toBeGreaterThan(1);
  });

  it("warns before adding a sold-out product, and does not add it yet", () => {
    mockStock = { levels: STOCKED, loading: false, error: null, refetch: () => {} };
    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Rice 5kg/ }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/sold out/i);
    expect(dialog.textContent).toMatch(/will not sync/i);
    // Still only the grid tile — nothing in the cart.
    expect(screen.getAllByText("Rice 5kg")).toHaveLength(1);
  });

  it("warns differently for a product never stocked here", () => {
    mockStock = { levels: STOCKED, loading: false, error: null, refetch: () => {} };
    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Sachet Water/ }));

    expect(screen.getByRole("alertdialog").textContent).toMatch(/never been stocked/i);
  });

  it("sells anyway when the cashier confirms — warn, never block", () => {
    // The shop may genuinely have stock the books do not know about. Refusing
    // real money on a stale count is the worse failure.
    mockStock = { levels: STOCKED, loading: false, error: null, refetch: () => {} };
    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Rice 5kg/ }));
    fireEvent.click(screen.getByRole("button", { name: /sell anyway/i }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByText("Rice 5kg").length).toBeGreaterThan(1);
  });

  it("does not add the item when the warning is cancelled", () => {
    mockStock = { levels: STOCKED, loading: false, error: null, refetch: () => {} };
    render(<PosScreen />);

    fireEvent.click(screen.getByRole("button", { name: /Rice 5kg/ }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByText("Rice 5kg")).toHaveLength(1);
  });

  it("shows remaining counts on the tiles when stock is known", () => {
    mockStock = { levels: STOCKED, loading: false, error: null, refetch: () => {} };
    render(<PosScreen />);

    expect(screen.getByText("12 left")).toBeTruthy();
    expect(screen.getByText("Sold out")).toBeTruthy();
    // Four of the six mock products have no level row, so this is plural.
    expect(screen.getAllByText("Not stocked")).toHaveLength(4);
  });

  it("says NOTHING about stock when offline, and never warns", () => {
    // The whole point of not caching stock: offline we have no number, so we
    // show no number and get out of the cashier's way.
    mockStock = { levels: [], loading: false, error: new Error("offline"), refetch: () => {} };
    render(<PosScreen />);

    expect(screen.queryByText(/left$/)).toBeNull();
    expect(screen.queryByText("Sold out")).toBeNull();
    expect(screen.queryByText("Not stocked")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Rice 5kg/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
