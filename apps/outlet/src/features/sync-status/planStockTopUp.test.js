import { describe, it, expect } from "vitest";

import { planStockTopUp, indexProductNames } from "./planStockTopUp.js";

const stock = (entries) => new Map(Object.entries(entries));
const names = (entries) => new Map(Object.entries(entries));

const sale = (lineItems) => ({ line_items: lineItems });

describe("planStockTopUp", () => {
  it("plans the exact shortfall, not the whole quantity", () => {
    // Sold 5, books show 3 — only 2 units were unrecorded. Topping up by 5
    // would invent two units of inventory that never existed.
    const plan = planStockTopUp(
      sale([{ product_id: "p1", quantity: 5 }]),
      stock({ p1: 3 }),
      names({ p1: "Milo 400g" })
    );

    expect(plan).toEqual([
      { product_id: "p1", name: "Milo 400g", requested: 5, available: 3, shortfall: 2 },
    ]);
  });

  it("ignores lines that are already covered", () => {
    const plan = planStockTopUp(
      sale([
        { product_id: "p1", quantity: 2 },
        { product_id: "p2", quantity: 1 },
      ]),
      stock({ p1: 10, p2: 0 }),
      names({ p1: "Milo", p2: "Rice" })
    );

    expect(plan).toHaveLength(1);
    expect(plan[0].product_id).toBe("p2");
    expect(plan[0].shortfall).toBe(1);
  });

  it("sums a product that appears on more than one line", () => {
    // The server checks the total per product. Planning per line would top up
    // twice for half the shortfall each time and still fail on resend.
    const plan = planStockTopUp(
      sale([
        { product_id: "p1", quantity: 3 },
        { product_id: "p1", quantity: 4 },
      ]),
      stock({ p1: 2 }),
      names({ p1: "Milo" })
    );

    expect(plan).toHaveLength(1);
    expect(plan[0].requested).toBe(7);
    expect(plan[0].shortfall).toBe(5);
  });

  it("treats a product with no stock row as zero available, like the server", () => {
    const plan = planStockTopUp(
      sale([{ product_id: "never-stocked", quantity: 4 }]),
      stock({}),
      names({ "never-stocked": "Kalyppo" })
    );

    expect(plan[0]).toMatchObject({ available: 0, shortfall: 4 });
  });

  it("returns an empty plan when everything is covered", () => {
    const plan = planStockTopUp(
      sale([{ product_id: "p1", quantity: 1 }]),
      stock({ p1: 50 }),
      names({ p1: "Milo" })
    );
    expect(plan).toEqual([]);
  });

  it("falls back to the product id rather than rendering 'undefined'", () => {
    const plan = planStockTopUp(sale([{ product_id: "p9", quantity: 1 }]), stock({}), names({}));
    expect(plan[0].name).toBe("p9");
  });

  it("survives a malformed or missing payload", () => {
    expect(planStockTopUp(null, stock({}), names({}))).toEqual([]);
    expect(planStockTopUp({}, stock({}), names({}))).toEqual([]);
    expect(planStockTopUp(sale("nope"), stock({}), names({}))).toEqual([]);
  });

  it("skips line items with a missing or non-positive quantity", () => {
    const plan = planStockTopUp(
      sale([
        { product_id: "p1" },
        { product_id: "p2", quantity: 0 },
        { product_id: "p3", quantity: -2 },
        { quantity: 5 },
      ]),
      stock({}),
      names({})
    );
    expect(plan).toEqual([]);
  });

  it("tolerates non-Map arguments", () => {
    const plan = planStockTopUp(sale([{ product_id: "p1", quantity: 2 }]), null, undefined);
    expect(plan[0]).toMatchObject({ available: 0, shortfall: 2 });
  });
});

describe("indexProductNames", () => {
  it("names products from stock levels", () => {
    const m = indexProductNames(null, [{ product_id: "p1", product_name: "Milo" }]);
    expect(m.get("p1")).toBe("Milo");
  });

  it("prefers the catalog, which covers products with no stock row", () => {
    // The never-stocked case is the one most likely to land here, and it has
    // no level row to take a name from.
    const m = indexProductNames(
      [{ id: "p1", name: "Milo 400g Tin" }],
      [{ product_id: "p1", product_name: "Milo" }]
    );
    expect(m.get("p1")).toBe("Milo 400g Tin");
  });

  it("survives missing inputs", () => {
    expect(indexProductNames(null, null).size).toBe(0);
    expect(indexProductNames([{}], [{}]).size).toBe(0);
  });
});
