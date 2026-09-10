import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import StockLevelList from "./StockLevelList.jsx";

function makeLevel(overrides = {}) {
  return {
    product_id: "prod-1",
    product_name: "Rice 5kg",
    sku: "RICE5",
    quantity: 10,
    min_stock: 10,
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("StockLevelList", () => {
  it("shows the empty message when there are no levels", () => {
    render(<StockLevelList levels={[]} />);
    expect(screen.getByText("No stock levels loaded yet.")).toBeTruthy();
  });

  it("renders a row per product with name, sku, and quantity", () => {
    render(<StockLevelList levels={[makeLevel({ quantity: 25, min_stock: 5 })]} />);
    expect(screen.getByText("Rice 5kg")).toBeTruthy();
    expect(screen.getByText("RICE5")).toBeTruthy();
    expect(screen.getByText("25")).toBeTruthy();
  });

  it("flags a row as low stock when quantity === min_stock (boundary)", () => {
    render(<StockLevelList levels={[makeLevel({ quantity: 10, min_stock: 10 })]} />);
    expect(screen.getByText("Low stock")).toBeTruthy();
    expect(screen.getByRole("status", { name: /low stock: rice 5kg/i })).toBeTruthy();
  });

  it("flags a row as low stock when quantity < min_stock", () => {
    render(<StockLevelList levels={[makeLevel({ quantity: 2, min_stock: 10 })]} />);
    expect(screen.getByText("Low stock")).toBeTruthy();
  });

  it("does NOT flag a row when quantity === min_stock + 1 (just above the boundary)", () => {
    render(<StockLevelList levels={[makeLevel({ quantity: 11, min_stock: 10 })]} />);
    expect(screen.queryByText("Low stock")).toBeNull();
  });

  it("does NOT flag a row when min_stock is null, even if quantity is 0", () => {
    render(<StockLevelList levels={[makeLevel({ quantity: 0, min_stock: null })]} />);
    expect(screen.queryByText("Low stock")).toBeNull();
  });

  it("does NOT flag a row when min_stock is undefined (defensive, same as null)", () => {
    const level = makeLevel({ quantity: 0 });
    delete level.min_stock;
    render(<StockLevelList levels={[level]} />);
    expect(screen.queryByText("Low stock")).toBeNull();
  });

  it("does not render a sku span when sku is null", () => {
    render(<StockLevelList levels={[makeLevel({ sku: null })]} />);
    expect(screen.queryByText("RICE5")).toBeNull();
  });

  it("calls onAdjust with the level when Adjust is tapped", () => {
    const onAdjust = vi.fn();
    const level = makeLevel();
    render(<StockLevelList levels={[level]} onAdjust={onAdjust} />);
    screen.getByRole("button", { name: /adjust/i }).click();
    expect(onAdjust).toHaveBeenCalledWith(level);
  });

  it("applies the low-stock row class alongside the text badge (colour is never the only cue)", () => {
    const { container } = render(
      <StockLevelList levels={[makeLevel({ quantity: 1, min_stock: 5 })]} />
    );
    const row = container.querySelector("li");
    expect(row.className).toContain("ub-stock-list__row--low");
    expect(screen.getByText("Low stock")).toBeTruthy();
  });
});
