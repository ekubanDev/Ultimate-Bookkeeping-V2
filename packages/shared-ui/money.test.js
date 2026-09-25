import { describe, it, expect } from "vitest";

import { formatMoney } from "./money.js";

describe("formatMoney", () => {
  it("adds the cedi symbol and keeps two decimals", () => {
    expect(formatMoney("45.00")).toBe("₵45.00");
    expect(formatMoney("0.00")).toBe("₵0.00");
  });

  it("groups thousands", () => {
    expect(formatMoney("1234.50")).toBe("₵1,234.50");
    expect(formatMoney("35967.00")).toBe("₵35,967.00");
    expect(formatMoney("1000000.00")).toBe("₵1,000,000.00");
  });

  it("puts the minus sign outside the symbol, so a refund reads as one", () => {
    expect(formatMoney("-12.00")).toBe("-₵12.00");
    expect(formatMoney("-1234.50")).toBe("-₵1,234.50");
  });

  it("pads a short or missing fraction to two places", () => {
    expect(formatMoney("45.5")).toBe("₵45.50");
    expect(formatMoney("45")).toBe("₵45.00");
  });

  it("formats the full NUMERIC(12,2) range", () => {
    expect(formatMoney("9999999999.99")).toBe("₵9,999,999,999.99");
    expect(formatMoney("0.30")).toBe("₵0.30");
    expect(formatMoney("8.20")).toBe("₵8.20");
  });

  it("carries digits through as text, not through a double", () => {
    // HONEST SCOPE. Within NUMERIC(12,2) this property is NOT observable: a
    // double holds every value the column can store, so a parseFloat
    // implementation prints exactly the same thing for every legal input.
    // Sabotaging money.js to use parseFloat was tried, and the whole suite
    // still passed — an earlier version of this test claimed to forbid floats
    // and proved nothing at all.
    //
    // This input is deliberately BEYOND the column's precision. It cannot
    // arrive from this API. It is here because it is the only way to make the
    // mechanism visible: string formatting preserves the digits, a double
    // rounds them to ...568.00 and loses the cents entirely.
    expect(formatMoney("12345678901234567.89")).toBe("₵12,345,678,901,234,567.89");
  });

  it("returns something unrecognizable unchanged rather than inventing zero", () => {
    // A silent "₵0.00" is indistinguishable from a real zero, which is the
    // one wrong answer that cannot be spotted on screen.
    expect(formatMoney("not money")).toBe("not money");
    expect(formatMoney("")).toBe("");
    expect(formatMoney("12.345")).toBe("12.345");
  });

  it("refuses to accept a number, so a float upstream stays visible", () => {
    expect(formatMoney(45)).toBe("45");
    expect(formatMoney(45.5)).toBe("45.5");
  });

  it("handles null and undefined without throwing", () => {
    expect(formatMoney(null)).toBe("");
    expect(formatMoney(undefined)).toBe("");
  });

  it("accepts a different symbol for reuse by the admin app", () => {
    expect(formatMoney("45.00", { symbol: "$" })).toBe("$45.00");
  });
});
