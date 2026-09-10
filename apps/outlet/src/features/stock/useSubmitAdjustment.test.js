import { describe, expect, it } from "vitest";
import { buildAdjustmentIntent } from "./useSubmitAdjustment.js";

const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

describe("buildAdjustmentIntent", () => {
  it("returns a well-formed stock_adjustment intent with the right shape", () => {
    const intent = buildAdjustmentIntent({
      productId: "prod-1",
      outletId: "outlet-1",
      delta: -3,
      reason: "sale",
      clientId: CLIENT_ID,
    });

    expect(intent).toEqual({
      client_id: CLIENT_ID,
      type: "stock_adjustment",
      payload: {
        client_id: CLIENT_ID,
        product_id: "prod-1",
        outlet_id: "outlet-1",
        delta: -3,
        reason: "sale",
      },
    });
  });

  it("passes client_id through untouched to both the envelope and the payload", () => {
    const intent = buildAdjustmentIntent({
      productId: "prod-1",
      outletId: "outlet-1",
      delta: 10,
      clientId: CLIENT_ID,
    });

    expect(intent.client_id).toBe(CLIENT_ID);
    expect(intent.payload.client_id).toBe(CLIENT_ID);
  });

  it("defaults reason to 'adjustment' when omitted", () => {
    const intent = buildAdjustmentIntent({
      productId: "prod-1",
      outletId: "outlet-1",
      delta: 1,
      clientId: CLIENT_ID,
    });

    expect(intent.payload.reason).toBe("adjustment");
  });

  it("preserves a positive (restock) delta exactly", () => {
    const intent = buildAdjustmentIntent({
      productId: "prod-1",
      outletId: "outlet-1",
      delta: 25,
      reason: "restock",
      clientId: CLIENT_ID,
    });

    expect(intent.payload.delta).toBe(25);
  });

  it("is pure: same inputs always produce an equal (deep-equal) result", () => {
    const args = [
      {
        productId: "prod-1",
        outletId: "outlet-1",
        delta: -1,
        reason: "adjustment",
        clientId: CLIENT_ID,
      },
    ];

    expect(buildAdjustmentIntent(...args)).toEqual(buildAdjustmentIntent(...args));
  });
});
