/**
 * productStock — turn GET /api/v1/stock/levels into something a till can act on.
 *
 * THREE STATES THAT LOOK THE SAME AND ARE NOT. The server reports
 * `available = 0` both for a product that is sold out and for one with no
 * `stock_levels` row at all, and the app previously had no stock data
 * whatsoever. Collapsing those is what let a cashier ring up a sale that
 * could never sync:
 *
 *   unknown      - we have no stock data right now (offline, still loading,
 *                  or the fetch failed). Say NOTHING. A blank is honest; a
 *                  zero is a lie that stops a real sale.
 *   not_stocked  - we have stock data, and this product has no row in it.
 *                  It has never been stocked at this outlet.
 *   out          - stocked here, currently at or below zero.
 *   low          - at or below the catalog's min_stock threshold.
 *   ok           - nothing to say.
 *
 * `unknown` is the reason this takes an explicit `hasStockData` flag rather
 * than inferring from an empty map: "no levels loaded" and "levels loaded,
 * none for this product" are opposite answers and an empty array cannot
 * distinguish them.
 *
 * WARNING, NOT BLOCKING. `shouldWarnBeforeSelling` marks the states worth a
 * confirmation. It never prevents a sale: a stale or missing count must not
 * refuse money at the till, and the runbook's own rule is that a wrong stock
 * number is worse than no number. The server still rejects a genuine
 * oversell at sync — this exists so that stops being a surprise hours later.
 */

export const STOCK_UNKNOWN = "unknown";
export const STOCK_NOT_STOCKED = "not_stocked";
export const STOCK_OUT = "out";
export const STOCK_LOW = "low";
export const STOCK_OK = "ok";

/** product_id -> quantity, from the /stock/levels payload. */
export function indexStockLevels(levels) {
  const byProduct = new Map();
  if (!Array.isArray(levels)) return byProduct;
  for (const level of levels) {
    if (!level || typeof level.product_id !== "string") continue;
    if (typeof level.quantity !== "number") continue;
    byProduct.set(level.product_id, level.quantity);
  }
  return byProduct;
}

/**
 * @param {object} product        a catalog product (needs id, maybe min_stock)
 * @param {Map<string, number>} byProduct  from indexStockLevels
 * @param {boolean} hasStockData  did a stock fetch actually succeed?
 * @returns {{ state: string, quantity: number|null, label: string|null }}
 */
export function describeStock(product, byProduct, hasStockData) {
  if (!hasStockData) {
    return { state: STOCK_UNKNOWN, quantity: null, label: null };
  }

  const quantity = byProduct instanceof Map ? byProduct.get(product?.id) : undefined;

  if (quantity === undefined) {
    return { state: STOCK_NOT_STOCKED, quantity: null, label: "Not stocked" };
  }
  if (quantity <= 0) {
    return { state: STOCK_OUT, quantity, label: "Sold out" };
  }

  const minStock = typeof product?.min_stock === "number" ? product.min_stock : null;
  if (minStock !== null && quantity <= minStock) {
    return { state: STOCK_LOW, quantity, label: `${quantity} left` };
  }
  return { state: STOCK_OK, quantity, label: `${quantity} left` };
}

/** Which states deserve a confirmation before the item joins the cart. */
export function shouldWarnBeforeSelling(state) {
  return state === STOCK_OUT || state === STOCK_NOT_STOCKED;
}

/** Plain-language reason for the confirmation, for the cashier. */
export function warningFor(state, productName) {
  if (state === STOCK_NOT_STOCKED) {
    return `${productName} has never been stocked at this outlet. Selling it will not sync until stock is recorded.`;
  }
  if (state === STOCK_OUT) {
    return `${productName} shows as sold out. Selling it will not sync until stock is recorded.`;
  }
  return null;
}
