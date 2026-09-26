/**
 * fetchAllProducts — page through GET /api/v1/products until the catalog is
 * exhausted.
 *
 * THE BUG THIS FIXES. `list_products` declares
 * `limit: int = Query(default=50, ge=1, le=200)`, and this app sent neither
 * `limit` nor `offset`. So the POS received the first **50** products by name
 * and nothing anywhere said so. With the pilot outlet's 213-product catalog
 * that left 163 products (76%) invisible and therefore unsellable — the
 * catalog "loaded fine", it was simply a quarter of itself.
 *
 * Raising the default would not have been a fix. The server's cap is
 * `le=200`, which is already below 213, so no single request can return this
 * catalog however it is parameterised. Paging is the only correct answer, and
 * it stays correct as the catalog grows.
 *
 * TERMINATION: a page shorter than `pageSize` means the end. MAX_PAGES is a
 * backstop so a server that always returns a full page cannot spin this
 * forever inside a hook that runs on every POS mount.
 */

/** The server's own `le` ceiling — asking for more is rejected outright. */
export const PAGE_SIZE = 200;

/** 10,000 products at PAGE_SIZE. Far beyond a real outlet catalog. */
export const MAX_PAGES = 50;

export async function fetchAllProducts(getProducts, outletId, options = {}) {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const all = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await getProducts({
      outlet_id: outletId,
      limit: pageSize,
      offset: page * pageSize,
    });

    const items = Array.isArray(batch) ? batch : [];
    all.push(...items);

    // A short page is the last page. An empty one ends it too, which also
    // covers offset landing exactly on the catalog size.
    if (items.length < pageSize) return all;
  }

  // Hit the backstop. Return what we have rather than throwing — a partial
  // catalog still lets the shop trade — but say so, because silently serving
  // a truncated catalog is the exact failure this function exists to end.
  // eslint-disable-next-line no-console
  console.warn(
    `fetchAllProducts: stopped at ${MAX_PAGES} pages (${all.length} products). ` +
      "The catalog may be truncated."
  );
  return all;
}
