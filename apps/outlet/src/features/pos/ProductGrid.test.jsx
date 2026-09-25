/**
 * ProductGrid rendered prices.
 *
 * The grid previously rendered `{product.unit_price}` raw, so a tile read
 * "45.00" with no currency at all. These tests pin the formatted output,
 * because the hook-level tests (useCart, useSubmitSale) all assert on the
 * wire strings and would stay green no matter what the tiles displayed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import ProductGrid from "./ProductGrid.jsx";

const PRODUCTS = [
  { id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00" },
  { id: "prod-2", name: "Milo 400g Tin", unit_price: "45.00" },
  { id: "prod-3", name: "Bulk item", unit_price: "1234.50" },
];

describe("ProductGrid", () => {
  it("shows each price with the cedi symbol, not a bare number", () => {
    render(<ProductGrid products={PRODUCTS} />);

    expect(screen.getByText("₵5.00")).toBeTruthy();
    expect(screen.getByText("₵45.00")).toBeTruthy();
    // The unformatted value must not survive anywhere on the tile.
    expect(screen.queryByText("45.00")).toBeNull();
  });

  it("groups thousands so a large price is readable at a glance", () => {
    render(<ProductGrid products={PRODUCTS} />);
    expect(screen.getByText("₵1,234.50")).toBeTruthy();
  });

  it("renders one tappable tile per product", () => {
    render(<ProductGrid products={PRODUCTS} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("passes the whole product back when a tile is tapped", () => {
    const onAddProduct = vi.fn();
    render(<ProductGrid products={PRODUCTS} onAddProduct={onAddProduct} />);

    fireEvent.click(screen.getByRole("button", { name: /Milo 400g Tin/ }));

    expect(onAddProduct).toHaveBeenCalledTimes(1);
    // The unformatted string is what goes to the cart and then the API —
    // formatting is display-only and must not leak into the payload.
    expect(onAddProduct).toHaveBeenCalledWith(PRODUCTS[1]);
    expect(onAddProduct.mock.calls[0][0].unit_price).toBe("45.00");
  });

  it("shows an empty state rather than a bare grid", () => {
    render(<ProductGrid products={[]} />);
    expect(screen.getByText(/No products loaded yet/i)).toBeTruthy();
  });
});
