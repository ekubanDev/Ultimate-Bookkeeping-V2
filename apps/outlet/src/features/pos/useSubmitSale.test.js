import { describe, expect, it } from "vitest";
import { buildSaleIntent } from "./useSubmitSale.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_RECORDED_AT = "2026-09-01T09:00:00.000Z";

const LINE_ITEMS = [{ product_id: "prod-1", quantity: 2, submitted_unit_price: "5.00" }];

describe("buildSaleIntent", () => {
  it("returns a well-formed sale intent with the right shape", () => {
    const intent = buildSaleIntent(LINE_ITEMS, {
      outletId: "outlet-1",
      paymentMethod: "cash",
      discountType: "fixed",
      discountValue: "1.00",
      taxAmount: "0.50",
      deviceRecordedAt: DEVICE_RECORDED_AT,
      clientId: CLIENT_ID,
    });

    expect(intent).toEqual({
      client_id: CLIENT_ID,
      type: "sale",
      payload: {
        client_id: CLIENT_ID,
        outlet_id: "outlet-1",
        line_items: LINE_ITEMS,
        payment_method: "cash",
        discount_type: "fixed",
        discount_value: "1.00",
        tax_amount: "0.50",
        device_recorded_at: DEVICE_RECORDED_AT,
      },
    });
  });

  it("supports a percentage discount type", () => {
    const intent = buildSaleIntent(LINE_ITEMS, {
      outletId: "outlet-1",
      paymentMethod: "mobile_money",
      discountType: "percentage",
      discountValue: "10.00",
      taxAmount: "0.00",
      deviceRecordedAt: DEVICE_RECORDED_AT,
      clientId: CLIENT_ID,
    });

    expect(intent.payload.discount_type).toBe("percentage");
    expect(intent.payload.discount_value).toBe("10.00");
  });

  it("passes client_id through untouched to both the envelope and the payload", () => {
    const intent = buildSaleIntent(LINE_ITEMS, {
      outletId: "outlet-1",
      paymentMethod: "cash",
      deviceRecordedAt: DEVICE_RECORDED_AT,
      clientId: CLIENT_ID,
    });

    expect(intent.client_id).toBe(CLIENT_ID);
    expect(intent.payload.client_id).toBe(CLIENT_ID);
  });

  it("defaults discount_type to 'fixed', discount_value and tax_amount to '0.00' when omitted", () => {
    const intent = buildSaleIntent(LINE_ITEMS, {
      outletId: "outlet-1",
      paymentMethod: "mobile_money",
      deviceRecordedAt: DEVICE_RECORDED_AT,
      clientId: CLIENT_ID,
    });

    expect(intent.payload.discount_type).toBe("fixed");
    expect(intent.payload.discount_value).toBe("0.00");
    expect(intent.payload.tax_amount).toBe("0.00");
  });

  it("preserves money strings exactly, without parsing them to numbers", () => {
    const intent = buildSaleIntent(
      [{ product_id: "prod-1", quantity: 1, submitted_unit_price: "5.10" }],
      {
        outletId: "outlet-1",
        paymentMethod: "card",
        discountType: "fixed",
        discountValue: "0.30",
        taxAmount: "0.05",
        deviceRecordedAt: DEVICE_RECORDED_AT,
        clientId: CLIENT_ID,
      }
    );

    expect(intent.payload.line_items[0].submitted_unit_price).toBe("5.10");
    expect(intent.payload.discount_value).toBe("0.30");
    expect(intent.payload.tax_amount).toBe("0.05");
  });

  it("is pure: same inputs always produce an equal (deep-equal) result", () => {
    const args = [
      LINE_ITEMS,
      {
        outletId: "outlet-1",
        paymentMethod: "cash",
        deviceRecordedAt: DEVICE_RECORDED_AT,
        clientId: CLIENT_ID,
      },
    ];

    expect(buildSaleIntent(...args)).toEqual(buildSaleIntent(...args));
  });
});
