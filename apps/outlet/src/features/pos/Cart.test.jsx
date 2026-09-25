/**
 * Cart rendering — line prices and the running subtotal.
 *
 * The subtotal line used to read "Subtotal: 5.00". useCart's own tests assert
 * the computed string and pass either way, so nothing covered what the
 * cashier actually sees.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import Cart from "./Cart.jsx";

const LINES = [
  { product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 2 },
  { product_id: "prod-2", name: "Milo 400g Tin", unit_price: "45.00", quantity: 1 },
];

describe("Cart", () => {
  it("formats the subtotal as money", () => {
    render(<Cart lineItems={LINES} total="55.00" />);

    expect(screen.getByText("₵55.00")).toBeTruthy();
    expect(screen.queryByText("55.00")).toBeNull();
  });

  it("keeps the word Subtotal beside the amount", () => {
    // Split across two spans for layout; the label must still be present.
    render(<Cart lineItems={LINES} total="55.00" />);
    expect(screen.getByText("Subtotal")).toBeTruthy();
  });

  it("formats each line price", () => {
    render(<Cart lineItems={LINES} total="55.00" />);
    expect(screen.getByText("₵5.00")).toBeTruthy();
    expect(screen.getByText("₵45.00")).toBeTruthy();
  });

  it("shows a zero subtotal as money, not an empty space", () => {
    render(<Cart lineItems={[]} total="0.00" />);
    expect(screen.getByText("₵0.00")).toBeTruthy();
    expect(screen.getByText(/Cart is empty/i)).toBeTruthy();
  });

  it("still reports quantities and wires up the steppers", () => {
    const onSetQuantity = vi.fn();
    render(<Cart lineItems={LINES} total="55.00" onSetQuantity={onSetQuantity} />);

    fireEvent.click(screen.getByRole("button", { name: "Increase quantity of Milo 400g Tin" })
    );

    expect(onSetQuantity).toHaveBeenCalledWith("prod-2", 2);
  });

  it("removes a line through the callback", () => {
    const onRemoveItem = vi.fn();
    render(<Cart lineItems={LINES} total="55.00" onRemoveItem={onRemoveItem} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    expect(onRemoveItem).toHaveBeenCalledWith("prod-1");
  });
});
