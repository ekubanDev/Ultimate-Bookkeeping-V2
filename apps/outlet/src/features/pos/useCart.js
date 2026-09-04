import { useCallback, useMemo, useReducer } from "react";

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
 *
 * State shape: per tesseract-fp-guide.md §4, cart state is driven by
 * useReducer over a pure cartReducer(state, action) rather than scattered
 * useState mutations — cartReducer is exported directly so it can be unit
 * tested without mounting a component.
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

/** @type {CartLineItem[]} */
const INITIAL_STATE = [];

/**
 * cartReducer — pure reducer over the cart's line-item list. Never mutates
 * `state` or any line item in place; every action returns a new array (and
 * new line-item objects where changed), per tesseract-fp-guide.md §4's
 * `addToCart` example. Exported for direct unit testing.
 *
 * Actions:
 *  - ADD_ITEM     { product: { id, name, unit_price }, quantity? } — merges
 *                  into an existing line (quantity += quantity) or appends
 *                  a new line. `quantity` defaults to 1.
 *  - REMOVE_ITEM   { productId } — drops the line entirely.
 *  - SET_QUANTITY  { productId, quantity } — sets the line's quantity;
 *                  quantity <= 0 removes the line (same rule REMOVE_ITEM
 *                  enforces), mirroring a cashier zeroing-out a stepper.
 *  - CLEAR         {} — empties the cart (post-checkout).
 *
 * @param {CartLineItem[]} state
 * @param {{type: string, [key: string]: unknown}} action
 * @returns {CartLineItem[]}
 */
export function cartReducer(state = INITIAL_STATE, action) {
  switch (action.type) {
    case "ADD_ITEM": {
      const { product, quantity = 1 } = action;
      const existing = state.find((li) => li.product_id === product.id);
      if (existing) {
        return state.map((li) =>
          li.product_id === product.id
            ? { ...li, quantity: li.quantity + quantity }
            : li
        );
      }
      return [
        ...state,
        {
          product_id: product.id,
          name: product.name,
          unit_price: product.unit_price,
          quantity,
        },
      ];
    }

    case "REMOVE_ITEM": {
      const { productId } = action;
      return state.filter((li) => li.product_id !== productId);
    }

    case "SET_QUANTITY": {
      const { productId, quantity } = action;
      if (quantity <= 0) {
        return state.filter((li) => li.product_id !== productId);
      }
      return state.map((li) =>
        li.product_id === productId ? { ...li, quantity } : li
      );
    }

    case "CLEAR":
      return INITIAL_STATE;

    default:
      return state;
  }
}

export function useCart() {
  const [lineItems, dispatch] = useReducer(cartReducer, INITIAL_STATE);

  const addItem = useCallback((product, quantity = 1) => {
    dispatch({ type: "ADD_ITEM", product, quantity });
  }, []);

  const removeItem = useCallback((productId) => {
    dispatch({ type: "REMOVE_ITEM", productId });
  }, []);

  const setQuantity = useCallback((productId, quantity) => {
    dispatch({ type: "SET_QUANTITY", productId, quantity });
  }, []);

  const clear = useCallback(() => dispatch({ type: "CLEAR" }), []);

  /**
   * Running subtotal (pre-discount, pre-tax) as a NUMERIC(12,2) string —
   * computed via integer cents, never floats. This is a CLIENT-SIDE PREVIEW
   * ONLY, shown to the cashier while building the cart. Discount/tax are
   * applied at checkout (CheckoutModal) and, per
   * ultimate-bookkeeping-v2-api-contracts.md §2, the server is the sole
   * pricing authority — it independently (re)computes
   * subtotal_amount/discount_amount/total_amount from the persisted line
   * items server-side; the POST /api/v1/sales response's `total_amount` is
   * the real, receipt-worthy figure, never this value.
   */
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
