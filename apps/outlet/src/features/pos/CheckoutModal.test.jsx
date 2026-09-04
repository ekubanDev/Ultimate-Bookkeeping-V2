import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CheckoutModal, { previewTotalCents } from "./CheckoutModal.jsx";

function renderModal(props = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <CheckoutModal
      isOpen
      onClose={onClose}
      subtotal="100.00"
      status="idle"
      onConfirm={onConfirm}
      {...props}
    />
  );
  return { onConfirm, onClose };
}

describe("CheckoutModal — discount type toggle", () => {
  it("defaults to a percentage discount of 0.00 and confirms with discount_type/discount_value fields", () => {
    const { onConfirm } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));

    expect(onConfirm).toHaveBeenCalledWith({
      paymentMethod: "cash",
      discountType: "percentage",
      discountValue: "0.00",
      taxAmount: "0.00",
    });
  });

  it("produces a percentage discount intent when a percentage value is entered", () => {
    const { onConfirm } = renderModal();

    fireEvent.change(screen.getByLabelText(/discount value \(%\)/i), {
      target: { value: "15.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ discountType: "percentage", discountValue: "15.00" })
    );
  });

  it("produces a fixed discount intent after toggling to fixed and entering a money value", () => {
    const { onConfirm } = renderModal();

    fireEvent.click(screen.getByRole("radio", { name: /fixed amount \(ghs\)/i }));
    fireEvent.change(screen.getByLabelText(/discount value \(ghs\)/i), {
      target: { value: "12.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ discountType: "fixed", discountValue: "12.50" })
    );
  });

  it("resets the discount value to a safe default when switching type", () => {
    renderModal();

    fireEvent.change(screen.getByLabelText(/discount value \(%\)/i), {
      target: { value: "25.00" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /fixed amount \(ghs\)/i }));

    expect(screen.getByLabelText(/discount value \(ghs\)/i).value).toBe("0.00");
  });
});

describe("CheckoutModal — validation (no parseFloat, regex-only)", () => {
  it("rejects a percentage value over 100 and blocks confirm", () => {
    const { onConfirm } = renderModal();

    fireEvent.change(screen.getByLabelText(/discount value \(%\)/i), {
      target: { value: "150.00" },
    });

    expect(screen.getByRole("alert").textContent).toMatch(/percentage from "0" to "100"/i);
    expect(screen.getByRole("button", { name: /confirm sale/i }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("rejects a percentage value with more than 2 decimal places", () => {
    renderModal();

    fireEvent.change(screen.getByLabelText(/discount value \(%\)/i), {
      target: { value: "10.123" },
    });

    expect(screen.getByRole("button", { name: /confirm sale/i }).disabled).toBe(true);
  });

  it("rejects a malformed money value on a fixed discount and blocks confirm", () => {
    const { onConfirm } = renderModal();

    fireEvent.click(screen.getByRole("radio", { name: /fixed amount \(ghs\)/i }));
    fireEvent.change(screen.getByLabelText(/discount value \(ghs\)/i), {
      target: { value: "12.5" }, // only 1 decimal place — not NUMERIC(12,2)-shaped
    });

    expect(screen.getByRole("alert").textContent).toMatch(/NUMERIC\(12,2\)/i);
    expect(screen.getByRole("button", { name: /confirm sale/i }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("still rejects a malformed tax value, independent of discount", () => {
    renderModal();

    fireEvent.change(screen.getByLabelText(/^tax$/i), { target: { value: "abc" } });

    expect(screen.getByRole("button", { name: /confirm sale/i }).disabled).toBe(true);
  });

  it("accepts a whole-number percentage (no decimal point required)", () => {
    const { onConfirm } = renderModal();

    fireEvent.change(screen.getByLabelText(/discount value \(%\)/i), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ discountType: "percentage", discountValue: "10" })
    );
  });

  it("accepts the upper bound 100 exactly", () => {
    const { onConfirm } = renderModal();

    fireEvent.change(screen.getByLabelText(/discount value \(%\)/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm sale/i }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ discountType: "percentage", discountValue: "100" })
    );
  });
});

describe("previewTotalCents — pure preview math (integer cents, half-up rounding)", () => {
  it("applies a fixed discount and adds tax", () => {
    // 100.00 subtotal, 20.00 fixed discount, 3.00 tax -> 83.00
    expect(
      previewTotalCents(10000, { discountType: "fixed", discountValue: "20.00", taxCents: 300 })
    ).toBe(8300);
  });

  it("applies a percentage discount, rounding half-up once", () => {
    // 30.00 subtotal, 10% discount -> 3.00 discount -> 27.00 total
    expect(
      previewTotalCents(3000, { discountType: "percentage", discountValue: "10.00", taxCents: 0 })
    ).toBe(2700);
  });

  it("rounds a fractional-cent percentage discount half-up", () => {
    // 1 cent subtotal * 50% = 0.5 cents -> rounds up to 1 cent discount -> total 0
    expect(
      previewTotalCents(1, { discountType: "percentage", discountValue: "50.00", taxCents: 0 })
    ).toBe(0);
  });

  it("never lets a discount push the preview below zero", () => {
    // Fixed discount larger than the subtotal is capped at the subtotal.
    expect(
      previewTotalCents(500, { discountType: "fixed", discountValue: "999.00", taxCents: 0 })
    ).toBe(0);
  });

  it("treats a 100% discount as zeroing the subtotal exactly", () => {
    expect(
      previewTotalCents(4999, { discountType: "percentage", discountValue: "100.00", taxCents: 150 })
    ).toBe(150);
  });
});
