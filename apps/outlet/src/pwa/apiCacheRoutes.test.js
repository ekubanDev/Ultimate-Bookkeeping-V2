import { describe, expect, it } from "vitest";
import {
  classifyApiRequest,
  isCacheableRead,
  OTHER_API_PATTERN,
  PRODUCTS_READ_PATTERN,
  STOCK_LEVELS_READ_PATTERN,
} from "./apiCacheRoutes.js";

describe("classifyApiRequest", () => {
  it("classifies GET /api/v1/products as a cacheable products read", () => {
    expect(classifyApiRequest("/api/v1/products", "GET")).toBe("products-read");
  });

  it("classifies GET /api/v1/products with a query string the same way", () => {
    expect(classifyApiRequest("/api/v1/products?outlet_id=outlet-1&limit=50", "GET")).toBe(
      "products-read"
    );
  });

  it("defaults to GET when no method is given", () => {
    expect(classifyApiRequest("/api/v1/products")).toBe("products-read");
  });

  it("classifies GET /api/v1/stock/levels as stock-levels-read, not cached", () => {
    expect(classifyApiRequest("/api/v1/stock/levels?outlet_id=outlet-1", "GET")).toBe(
      "stock-levels-read"
    );
  });

  it("classifies every other GET under /api/v1/ as other-api", () => {
    expect(classifyApiRequest("/api/v1/me", "GET")).toBe("other-api");
    expect(classifyApiRequest("/api/v1/sales?outlet_id=outlet-1", "GET")).toBe("other-api");
  });

  it("never classifies a mutation as a cacheable read, regardless of path", () => {
    // The exact hazard the offline-write contract cares about: a POST must
    // never fall into either cacheable-read bucket, even if it happens to
    // share a path prefix with one.
    expect(classifyApiRequest("/api/v1/products", "POST")).toBe("other-api");
    expect(classifyApiRequest("/api/v1/sales", "POST")).toBe("other-api");
    expect(classifyApiRequest("/api/v1/stock/adjustments", "POST")).toBe("other-api");
    expect(classifyApiRequest("/api/v1/expenses", "POST")).toBe("other-api");
  });

  it("is case-insensitive on method", () => {
    expect(classifyApiRequest("/api/v1/sales", "post")).toBe("other-api");
    expect(classifyApiRequest("/api/v1/products", "get")).toBe("products-read");
  });

  it("treats PUT/PATCH/DELETE the same as any other non-GET method", () => {
    expect(classifyApiRequest("/api/v1/products", "PUT")).toBe("other-api");
    expect(classifyApiRequest("/api/v1/products", "PATCH")).toBe("other-api");
    expect(classifyApiRequest("/api/v1/products", "DELETE")).toBe("other-api");
  });
});

describe("isCacheableRead", () => {
  it("is true only for GET /api/v1/products", () => {
    expect(isCacheableRead("/api/v1/products", "GET")).toBe(true);
  });

  it("is false for stock levels, other reads, and any mutation", () => {
    expect(isCacheableRead("/api/v1/stock/levels", "GET")).toBe(false);
    expect(isCacheableRead("/api/v1/me", "GET")).toBe(false);
    expect(isCacheableRead("/api/v1/products", "POST")).toBe(false);
  });
});

describe("route patterns stay in sync with what classifyApiRequest documents", () => {
  it("PRODUCTS_READ_PATTERN matches exactly what 'products-read' covers", () => {
    expect(PRODUCTS_READ_PATTERN.test("/api/v1/products")).toBe(true);
    expect(PRODUCTS_READ_PATTERN.test("/api/v1/products?outlet_id=x")).toBe(true);
    expect(PRODUCTS_READ_PATTERN.test("/api/v1/stock/levels")).toBe(false);
  });

  it("STOCK_LEVELS_READ_PATTERN matches only the stock-levels path", () => {
    expect(STOCK_LEVELS_READ_PATTERN.test("/api/v1/stock/levels?outlet_id=x")).toBe(true);
    expect(STOCK_LEVELS_READ_PATTERN.test("/api/v1/products")).toBe(false);
  });

  it("OTHER_API_PATTERN matches any /api/v1/ path (it's the deliberately broad catch-all)", () => {
    expect(OTHER_API_PATTERN.test("/api/v1/me")).toBe(true);
    expect(OTHER_API_PATTERN.test("/api/v1/sales")).toBe(true);
    expect(OTHER_API_PATTERN.test("/api/v1/products")).toBe(true);
  });
});
