/**
 * apiCacheRoutes.js — single source of truth for which /api/v1/* requests
 * the service worker is allowed to cache, and how.
 *
 * These RegExp constants are imported directly by vite.config.js's
 * `workbox.runtimeCaching` entries (they're plain data — a RegExp's
 * source/flags serialize fine into the generated service-worker file
 * regardless of which module the literal originally lived in) AND by this
 * file's own `classifyApiRequest`, which the test suite exercises. That's
 * the real reason this lives in its own module instead of being inlined
 * twice in vite.config.js: the build config and the test suite are
 * verifying the *same* pattern objects, not two hand-copied regexes that
 * could quietly drift apart.
 *
 * NOTE on what's deliberately NOT done here: Workbox's `urlPattern` also
 * accepts a callback function instead of a RegExp, which would let a
 * function like `classifyApiRequest` decide routing directly at runtime
 * inside the generated service worker. Not used: workbox-build's
 * `generateSW` embeds function-typed `urlPattern`s into the generated
 * sw.js via `Function.prototype.toString()` — the function runs in the
 * service worker's own global scope, which never executed this app's
 * build, so it cannot see this module's imports/closures. Sharing actual
 * *behavior* that way would silently break at runtime. Sharing the RegExp
 * *data* (this file's approach) has no such problem.
 */

/** GET /api/v1/products (with or without a query string). */
export const PRODUCTS_READ_PATTERN = /^\/api\/v1\/products(\?.*)?$/;

/** GET /api/v1/stock/levels (with or without a query string). */
export const STOCK_LEVELS_READ_PATTERN = /^\/api\/v1\/stock\/levels(\?.*)?$/;

/** Any other /api/v1/* request — reads not on the allowlist above, and every mutation. */
export const OTHER_API_PATTERN = /^\/api\/v1\//;

/**
 * classifyApiRequest — pure decision function mirroring the runtime-caching
 * routing rules in vite.config.js's `workbox.runtimeCaching`. Given a
 * request's path (+ optional query string) and method, returns which
 * caching treatment it falls under:
 *
 *   - 'products-read'    → GET /api/v1/products — cached (StaleWhileRevalidate)
 *   - 'stock-levels-read' → GET /api/v1/stock/levels — explicitly NetworkOnly
 *   - 'other-api'        → everything else under /api/v1/*, including every
 *                          POST — never cached, never matched by the
 *                          allowlist above regardless of path shape
 *
 * The method check comes first and is unconditional: nothing that isn't a
 * GET can ever classify as a cacheable read, no matter what the path looks
 * like. That's the property this module exists to make independently
 * testable — see apiCacheRoutes.test.js's "never caches a POST" cases.
 *
 * @param {string} path e.g. "/api/v1/products?outlet_id=abc"
 * @param {string} [method] defaults to "GET"
 * @returns {'products-read' | 'stock-levels-read' | 'other-api'}
 */
export function classifyApiRequest(path, method = "GET") {
  if (String(method).toUpperCase() !== "GET") {
    return "other-api";
  }
  if (PRODUCTS_READ_PATTERN.test(path)) {
    return "products-read";
  }
  if (STOCK_LEVELS_READ_PATTERN.test(path)) {
    return "stock-levels-read";
  }
  return "other-api";
}

/**
 * isCacheableRead — convenience predicate: true only for the one route
 * this pass actually caches (GET /api/v1/products). Kept separate from
 * classifyApiRequest so callers who only care about "is this safe to serve
 * from cache" don't need to know the full classification vocabulary.
 *
 * @param {string} path
 * @param {string} [method]
 * @returns {boolean}
 */
export function isCacheableRead(path, method = "GET") {
  return classifyApiRequest(path, method) === "products-read";
}
