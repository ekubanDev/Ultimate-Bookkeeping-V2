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

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ state: "queued", client_id: "mock-entry" });
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
