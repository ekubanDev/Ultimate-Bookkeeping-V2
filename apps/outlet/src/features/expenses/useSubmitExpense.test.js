import { describe, expect, it } from "vitest";
import { buildExpenseIntent } from "./useSubmitExpense.js";

const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const DEVICE_RECORDED_AT = "2026-09-01T09:00:00.000Z";

describe("buildExpenseIntent", () => {
  it("returns a well-formed expense intent with the right shape", () => {
    const intent = buildExpenseIntent({
      outletId: "outlet-1",
      amount: "50.00",
      category: "transport",
      note: "fuel for delivery",
      deviceRecordedAt: DEVICE_RECORDED_AT,
      clientId: CLIENT_ID,
    });

    expect(intent).toEqual({
      client_id: CLIENT_ID,
      type: "expense",
      payload: {
        client_id: CLIENT_ID,
        outlet_id: "outlet-1",
        amount: "50.00",
        category: "transport",
        note: "fuel for delivery",
        device_recorded_at: DEVICE_RECORDED_AT,
      },
    });
  });

  it("passes client_id through untouched to both the envelope and the payload", () => {
    const intent = buildExpenseIntent({
      outletId: "outlet-1",
      amount: "10.00",
      category: "utilities",
      deviceRecordedAt: DEVICE_RECORDED_AT,
      clientId: CLIENT_ID,
    });

    expect(intent.client_id).toBe(CLIENT_ID);
    expect(intent.payload.client_id).toBe(CLIENT_ID);
  });

  it("preserves the money string exactly, without parsing it to a number", () => {
    const intent = buildExpenseIntent({
      outletId: "outlet-1",
      amount: "1234.05",
      category: "supplies",
      deviceRecordedAt: DEVICE_RECORDED_AT,
      clientId: CLIENT_ID,
    });

    expect(intent.payload.amount).toBe("1234.05");
  });

  it("is pure: same inputs always produce an equal (deep-equal) result", () => {
    const args = [
      {
        outletId: "outlet-1",
        amount: "10.00",
        category: "utilities",
        deviceRecordedAt: DEVICE_RECORDED_AT,
        clientId: CLIENT_ID,
      },
    ];

    expect(buildExpenseIntent(...args)).toEqual(buildExpenseIntent(...args));
  });
});
