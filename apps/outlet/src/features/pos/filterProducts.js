/**
 * filterProducts — narrow the catalog by a cashier's typed query.
 *
 * Why this exists: the pilot outlet's catalog is 213 products and the POS
 * rendered every one of them as a flat list of tiles. Finding "Tuneful STW 12
 * inches" meant scrolling past two hundred others while a customer waited.
 *
 * Matching rules, chosen for someone typing one-handed at speed:
 *
 *   - Case-insensitive, and whitespace around the query is ignored.
 *   - Multiple words are ANDed, and order does not matter, so "12 tuneful"
 *     finds "Tuneful STW 12 inches". This matters because the products that
 *     differ only by a size or a bundle count ("4pcs" vs "5pcs") are exactly
 *     the ones a cashier needs to separate quickly.
 *   - Each word matches anywhere in the name OR the SKU — substring, not
 *     prefix, because staff know products by the middle of the name ("STW")
 *     at least as often as the start.
 *
 * `sku` is nullable in the API contract (ProductResponse — the column is
 * `Text | None`), so it is coerced defensively. A product with no SKU is
 * still findable by name rather than being silently excluded.
 *
 * Returns the SAME array reference when the query is empty, so the common
 * "not searching" case does not hand React a new array on every render.
 */

function haystack(product) {
  const name = typeof product?.name === "string" ? product.name : "";
  const sku = typeof product?.sku === "string" ? product.sku : "";
  return `${name} ${sku}`.toLowerCase();
}

export function filterProducts(products, query) {
  if (!Array.isArray(products)) return [];

  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return products;

  return products.filter((product) => {
    const text = haystack(product);
    return terms.every((term) => text.includes(term));
  });
}
