import { describe, it, expect } from "vitest";

import {
  indexStockLevels,
  describeStock,
  shouldWarnBeforeSelling,
  warningFor,
  STOCK_UNKNOWN,
  STOCK_NOT_STOCKED,
  STOCK_OUT,
  STOCK_LOW,
  STOCK_OK,
} from "./productStock.js";

const LEVELS = [
  { product_id: "p-plenty", product_name: "Rice 5kg", quantity: 40, sku: "RICE5" },
  { product_id: "p-low", product_name: "Milo 400g", quantity: 2, sku: "MILO" },
  { product_id: "p-zero", product_name: "Key Soap", quantity: 0, sku: "SOAP" },
];

const byProduct = indexStockLevels(LEVELS);

const product = (id, min_stock = null) => ({ id, name: `Product ${id}`, min_stock });

describe("indexStockLevels", () => {
  it("maps product_id to quantity", () => {
    expect(byProduct.get("p-plenty")).toBe(40);
    expect(byProduct.get("p-zero")).toBe(0);
  });

  it("survives a malformed payload", () => {
    expect(indexStockLevels(null).size).toBe(0);
    expect(indexStockLevels(undefined).size).toBe(0);
    expect(indexStockLevels([null, {}, { product_id: 1 }]).size).toBe(0);
  });

  it("skips rows with a non-numeric quantity rather than storing NaN", () => {
    const m = indexStockLevels([{ product_id: "x", quantity: "12" }]);
    expect(m.has("x")).toBe(false);
  });
});

describe("describeStock", () => {
  it("says nothing at all when there is no stock data", () => {
    // Offline or a failed fetch. A blank is honest; a zero would stop a real
    // sale on information we do not have.
    const result = describeStock(product("p-plenty"), byProduct, false);
    expect(result.state).toBe(STOCK_UNKNOWN);
    expect(result.label).toBeNull();
    expect(result.quantity).toBeNull();
  });

  it("distinguishes NOT STOCKED from SOLD OUT", () => {
    // The server reports available=0 for both. They are different facts and
    // the pilot catalog contains 32 of the first kind.
    expect(describeStock(product("p-never-seen"), byProduct, true).state).toBe(
      STOCK_NOT_STOCKED
    );
    expect(describeStock(product("p-zero"), byProduct, true).state).toBe(STOCK_OUT);
  });

  it("labels those two differently for the cashier", () => {
    expect(describeStock(product("p-never-seen"), byProduct, true).label).toBe(
      "Not stocked"
    );
    expect(describeStock(product("p-zero"), byProduct, true).label).toBe("Sold out");
  });

  it("reports a remaining count when in stock", () => {
    const result = describeStock(product("p-plenty"), byProduct, true);
    expect(result.state).toBe(STOCK_OK);
    expect(result.quantity).toBe(40);
    expect(result.label).toBe("40 left");
  });

  it("marks low stock using the catalog's own min_stock", () => {
    const result = describeStock(product("p-low", 5), byProduct, true);
    expect(result.state).toBe(STOCK_LOW);
    expect(result.label).toBe("2 left");
  });

  it("is not low when min_stock is absent", () => {
    // min_stock is nullable in ProductResponse; absent must not mean zero.
    expect(describeStock(product("p-low", null), byProduct, true).state).toBe(STOCK_OK);
  });

  it("treats a negative quantity as sold out, not as stock", () => {
    const m = indexStockLevels([{ product_id: "p-neg", quantity: -3 }]);
    expect(describeStock(product("p-neg"), m, true).state).toBe(STOCK_OUT);
  });
});

describe("shouldWarnBeforeSelling", () => {
  it("warns for sold out and not stocked", () => {
    expect(shouldWarnBeforeSelling(STOCK_OUT)).toBe(true);
    expect(shouldWarnBeforeSelling(STOCK_NOT_STOCKED)).toBe(true);
  });

  it("does NOT warn when stock is merely unknown", () => {
    // This is the offline case. Warning here would nag on every tap all day
    // with no information behind it.
    expect(shouldWarnBeforeSelling(STOCK_UNKNOWN)).toBe(false);
  });

  it("does not warn for low or ok", () => {
    expect(shouldWarnBeforeSelling(STOCK_LOW)).toBe(false);
    expect(shouldWarnBeforeSelling(STOCK_OK)).toBe(false);
  });
});

describe("warningFor", () => {
  it("explains the consequence, not just the state", () => {
    // "Sold out" alone does not tell a cashier why they should care.
    expect(warningFor(STOCK_OUT, "Key Soap")).toMatch(/will not sync/);
    expect(warningFor(STOCK_NOT_STOCKED, "Key Soap")).toMatch(/never been stocked/);
  });

  it("returns nothing for states that do not warn", () => {
    expect(warningFor(STOCK_OK, "Rice")).toBeNull();
    expect(warningFor(STOCK_UNKNOWN, "Rice")).toBeNull();
  });
});
