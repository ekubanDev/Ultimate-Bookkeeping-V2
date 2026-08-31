import { useCallback, useMemo, useState } from "react";

/**
 * useCart — pure client-side cart state for the POS screen. Per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §3: owns line items, quantities,
 * and the running total. Does NOT submit anything — that's useSubmitSale's
 * job, called once the cashier confirms checkout.
 *
 * Money handling: unit prices come in as strings (NUMERIC(12,2) wire
 * format, per CLAUDE.md) and are converted to integer cents internally so
 * running-total math never touches floats. Totals are exposed back out as
 * strings, matching what useSubmitSale needs to build the SaleRequest.
 */

/** "15.00" -> 1500 (integer cents). Never use this on untrusted/NaN input without validating first. */
function toCents(moneyString) {
  const [whole, fraction = "0"] = String(moneyString).split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Math.round(cents);
}

/** 1500 -> "15.00" */
function fromCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

/**
 * @typedef {Object} CartLineItem
 * @property {string} product_id
 * @property {string} name
 * @property {string} unit_price - "15.00" string, per wire format
 * @property {number} quantity
 */

export function useCart() {
  /** @type {[CartLineItem[], Function]} */
  const [lineItems, setLineItems] = useState([]);

  const addItem = useCallback((product, quantity = 1) => {
    setLineItems((prev) => {
      const existing = prev.find((li) => li.product_id === product.id);
      if (existing) {
        return prev.map((li) =>
          li.product_id === product.id
            ? { ...li, quantity: li.quantity + quantity }
            : li
        );
      }
      return [
        ...prev,
        {
          product_id: product.id,
          name: product.name,
          unit_price: product.unit_price,
          quantity,
        },
      ];
    });
  }, []);

  const removeItem = useCallback((productId) => {
    setLineItems((prev) => prev.filter((li) => li.product_id !== productId));
  }, []);

  const setQuantity = useCallback((productId, quantity) => {
    setLineItems((prev) => {
      if (quantity <= 0) {
        return prev.filter((li) => li.product_id !== productId);
      }
      return prev.map((li) =>
        li.product_id === productId ? { ...li, quantity } : li
      );
    });
  }, []);

  const clear = useCallback(() => setLineItems([]), []);

  /** Running total as a NUMERIC(12,2) string — computed via integer cents, never floats. */
  const total = useMemo(() => {
    const totalCents = lineItems.reduce(
      (sum, li) => sum + toCents(li.unit_price) * li.quantity,
      0
    );
    return fromCents(totalCents);
  }, [lineItems]);

  return {
    lineItems,
    addItem,
    removeItem,
    setQuantity,
    clear,
    total,
  };
}

export { toCents, fromCents };
