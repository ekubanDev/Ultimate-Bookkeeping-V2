import { describe, it, expect } from "vitest";

import { filterProducts } from "./filterProducts.js";

// Shaped like the real catalog, including the two cases that actually caused
// trouble: near-identical names separated only by a size, and a null SKU.
const CATALOG = [
  { id: "1", name: "Tuneful STW 12 inches", sku: "tuneful-stw-12" },
  { id: "2", name: "Tuneful STW 18 inches", sku: "tuneful-stw-18" },
  { id: "3", name: "Sachet Water (bag) 4pcs", sku: "sachet-water-4" },
  { id: "4", name: "Sachet Water (bag) 5pcs", sku: "sachet-water-5" },
  { id: "5", name: "Milo 400g Tin", sku: null },
];

const names = (result) => result.map((p) => p.name);

describe("filterProducts", () => {
  it("returns everything for an empty query", () => {
    expect(filterProducts(CATALOG, "")).toHaveLength(5);
    expect(filterProducts(CATALOG, "   ")).toHaveLength(5);
    expect(filterProducts(CATALOG, null)).toHaveLength(5);
    expect(filterProducts(CATALOG, undefined)).toHaveLength(5);
  });

  it("returns the same array reference when not filtering", () => {
    // Avoids handing React a fresh array on every render in the common case.
    expect(filterProducts(CATALOG, "")).toBe(CATALOG);
  });

  it("matches case-insensitively", () => {
    expect(names(filterProducts(CATALOG, "milo"))).toEqual(["Milo 400g Tin"]);
    expect(names(filterProducts(CATALOG, "MILO"))).toEqual(["Milo 400g Tin"]);
  });

  it("matches a substring from the middle of the name", () => {
    // Staff know products by the middle as often as the start.
    expect(filterProducts(CATALOG, "stw")).toHaveLength(2);
    expect(names(filterProducts(CATALOG, "400g"))).toEqual(["Milo 400g Tin"]);
  });

  it("ANDs multiple words regardless of order", () => {
    expect(names(filterProducts(CATALOG, "tuneful 12"))).toEqual([
      "Tuneful STW 12 inches",
    ]);
    expect(names(filterProducts(CATALOG, "12 tuneful"))).toEqual([
      "Tuneful STW 12 inches",
    ]);
  });

  it("separates products that differ only by size or bundle count", () => {
    // The real reason search was needed: these pairs are indistinguishable
    // when scanning a 213-item list.
    expect(names(filterProducts(CATALOG, "sachet 4"))).toEqual([
      "Sachet Water (bag) 4pcs",
    ]);
    expect(names(filterProducts(CATALOG, "sachet 5"))).toEqual([
      "Sachet Water (bag) 5pcs",
    ]);
  });

  it("matches on SKU too", () => {
    expect(names(filterProducts(CATALOG, "tuneful-stw-18"))).toEqual([
      "Tuneful STW 18 inches",
    ]);
  });

  it("still finds a product whose SKU is null", () => {
    // ProductResponse declares sku as nullable; excluding those silently
    // would make a real product unfindable.
    expect(names(filterProducts(CATALOG, "milo"))).toEqual(["Milo 400g Tin"]);
    expect(names(filterProducts(CATALOG, "tin"))).toEqual(["Milo 400g Tin"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterProducts(CATALOG, "bicycle")).toEqual([]);
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(names(filterProducts(CATALOG, "  tuneful   12  "))).toEqual([
      "Tuneful STW 12 inches",
    ]);
  });

  it("survives a malformed catalog rather than throwing mid-sale", () => {
    expect(filterProducts(null, "milo")).toEqual([]);
    expect(filterProducts(undefined, "milo")).toEqual([]);
    expect(filterProducts([{ id: "x" }, null], "milo")).toEqual([]);
  });
});
