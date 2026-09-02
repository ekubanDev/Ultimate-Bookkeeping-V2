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

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ state: "queued", client_id: "mock-entry" });
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
    expect(intent.payload.discount_amount).toBe("0.00");
    expect(intent.payload.tax_amount).toBe("0.00");
    expect(intent.payload.line_items).toEqual([
      { product_id: "prod-demo-water", quantity: 1, unit_price: "5.00" },
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
});
