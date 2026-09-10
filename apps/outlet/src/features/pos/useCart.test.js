import { describe, expect, it } from "vitest";
import { cartReducer } from "./useCart.js";

const water = { id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00" };
const milo = { id: "prod-2", name: "Milo 400g", unit_price: "45.00" };

describe("cartReducer", () => {
  it("ADD_ITEM appends a new line for a product not already in the cart", () => {
    const state = cartReducer([], { type: "ADD_ITEM", product: water, quantity: 1 });
    expect(state).toEqual([
      { product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 },
    ]);
  });

  it("ADD_ITEM defaults quantity to 1 when omitted", () => {
    const state = cartReducer([], { type: "ADD_ITEM", product: water });
    expect(state[0].quantity).toBe(1);
  });

  it("ADD_ITEM merges into an existing line by summing quantity, rather than duplicating it", () => {
    const afterFirst = cartReducer([], { type: "ADD_ITEM", product: water, quantity: 1 });
    const afterSecond = cartReducer(afterFirst, { type: "ADD_ITEM", product: water, quantity: 2 });

    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].quantity).toBe(3);
  });

  it("ADD_ITEM leaves other lines untouched when merging", () => {
    const state = [
      { product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 },
      { product_id: "prod-2", name: "Milo 400g", unit_price: "45.00", quantity: 1 },
    ];
    const next = cartReducer(state, { type: "ADD_ITEM", product: water, quantity: 1 });

    expect(next.find((li) => li.product_id === "prod-2")).toEqual(state[1]);
    // never mutates the input state array or its objects
    expect(state[0].quantity).toBe(1);
  });

  it("REMOVE_ITEM drops the matching line and leaves others untouched", () => {
    const state = [
      { product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 },
      { product_id: "prod-2", name: "Milo 400g", unit_price: "45.00", quantity: 2 },
    ];
    const next = cartReducer(state, { type: "REMOVE_ITEM", productId: "prod-1" });

    expect(next).toEqual([
      { product_id: "prod-2", name: "Milo 400g", unit_price: "45.00", quantity: 2 },
    ]);
  });

  it("SET_QUANTITY updates the matching line's quantity", () => {
    const state = [{ product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 }];
    const next = cartReducer(state, { type: "SET_QUANTITY", productId: "prod-1", quantity: 5 });

    expect(next[0].quantity).toBe(5);
  });

  it("SET_QUANTITY with quantity 0 removes the line", () => {
    const state = [{ product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 }];
    const next = cartReducer(state, { type: "SET_QUANTITY", productId: "prod-1", quantity: 0 });

    expect(next).toEqual([]);
  });

  it("SET_QUANTITY with a negative quantity also removes the line", () => {
    const state = [{ product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 3 }];
    const next = cartReducer(state, { type: "SET_QUANTITY", productId: "prod-1", quantity: -1 });

    expect(next).toEqual([]);
  });

  it("CLEAR empties the cart", () => {
    const state = [
      { product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 },
      { product_id: "prod-2", name: "Milo 400g", unit_price: "45.00", quantity: 2 },
    ];
    const next = cartReducer(state, { type: "CLEAR" });

    expect(next).toEqual([]);
  });

  it("is referentially transparent: same state + action always yields an equivalent result", () => {
    const state = [{ product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 }];
    const action = { type: "SET_QUANTITY", productId: "prod-1", quantity: 4 };

    expect(cartReducer(state, action)).toEqual(cartReducer(state, action));
  });

  it("unknown actions return the state unchanged", () => {
    const state = [{ product_id: "prod-1", name: "Sachet Water (bag)", unit_price: "5.00", quantity: 1 }];
    expect(cartReducer(state, { type: "NOT_A_REAL_ACTION" })).toBe(state);
  });
});
