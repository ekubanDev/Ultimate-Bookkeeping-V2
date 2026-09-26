/**
 * planStockTopUp — work out what stock correction would let a rejected sale
 * through, WITHOUT applying anything.
 *
 * THE SITUATION. A sale was rung up offline and queued. By the time it
 * reached the server the outlet's recorded stock could not cover it, so the
 * server returned INSUFFICIENT_STOCK with `retryable: false` and the entry
 * landed in `failed`. The goods have already left the shop.
 *
 * The resolution screen could only offer Retry (futile — the server will
 * reject it identically every time) or Discard (throws away a sale where
 * money changed hands). Neither records what happened.
 *
 * The honest third answer is a stock correction: the shelf held more than the
 * books knew, so record that as an explicit, attributable adjustment and then
 * resend the sale. That keeps stock_levels non-negative (its CheckConstraint
 * stays intact), keeps stock_levels equal to the sum of stock_movements, and
 * leaves an audit trail saying exactly what was corrected and by how much —
 * rather than a silently negative number.
 *
 * THIS FUNCTION ONLY PLANS. It returns what would be recorded so a human can
 * look at it and agree, because it is asserting that physical stock existed
 * which the system never saw. Nobody should sign that on the cashier's behalf.
 *
 * A product with no stock row is treated as 0 available, matching the server
 * (routers/sales.py: `available = level.quantity if level is not None else 0`).
 */

/**
 * @param {object} payload            the failed sale's stored payload
 * @param {Map<string, number>} stockByProduct  product_id -> current quantity
 * @param {Map<string, string>} namesByProduct  product_id -> display name
 * @returns {Array<{product_id: string, name: string, requested: number,
 *                  available: number, shortfall: number}>}
 */
export function planStockTopUp(payload, stockByProduct, namesByProduct) {
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const stock = stockByProduct instanceof Map ? stockByProduct : new Map();
  const names = namesByProduct instanceof Map ? namesByProduct : new Map();

  // One sale may legitimately contain the same product on two lines; the
  // server checks the TOTAL per product, so the plan must too. Summing first
  // avoids topping up twice for half the shortfall each time.
  const requestedByProduct = new Map();
  for (const item of lineItems) {
    const id = item?.product_id;
    const qty = item?.quantity;
    if (typeof id !== "string" || typeof qty !== "number" || qty <= 0) continue;
    requestedByProduct.set(id, (requestedByProduct.get(id) ?? 0) + qty);
  }

  const plan = [];
  for (const [product_id, requested] of requestedByProduct) {
    const available = stock.get(product_id) ?? 0;
    const shortfall = requested - available;
    if (shortfall <= 0) continue; // this line is already covered
    plan.push({
      product_id,
      name: names.get(product_id) ?? product_id,
      requested,
      available,
      shortfall,
    });
  }
  return plan;
}

/** product_id -> name, from whichever source has it. */
export function indexProductNames(products, levels) {
  const names = new Map();
  if (Array.isArray(levels)) {
    for (const level of levels) {
      if (level?.product_id && level?.product_name) {
        names.set(level.product_id, level.product_name);
      }
    }
  }
  // Catalog names win: a product with no stock row has no level to name it,
  // and that is exactly the case most likely to appear here.
  if (Array.isArray(products)) {
    for (const product of products) {
      if (product?.id && product?.name) names.set(product.id, product.name);
    }
  }
  return names;
}
