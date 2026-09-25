import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchAllProducts, PAGE_SIZE, MAX_PAGES } from "./fetchAllProducts.js";

/** A fake catalog of `n` products, named so order is checkable. */
const catalog = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Product ${i}` }));

/** A getProducts stub that serves `products` with real limit/offset slicing. */
const server = (products) =>
  vi.fn(async ({ limit, offset }) => products.slice(offset, offset + limit));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchAllProducts", () => {
  it("returns the WHOLE catalog when it exceeds one page", async () => {
    // The actual bug: 213 products, a 200 cap, and only the first page asked
    // for. Anything less than 213 here is the defect reappearing.
    const products = catalog(213);
    const getProducts = server(products);

    const result = await fetchAllProducts(getProducts, "outlet-1");

    expect(result).toHaveLength(213);
    expect(getProducts).toHaveBeenCalledTimes(2);
  });

  it("asks for an explicit limit and offset, never a bare query", async () => {
    // Sending neither is what truncated the catalog to the server's default.
    const getProducts = server(catalog(213));

    await fetchAllProducts(getProducts, "outlet-1");

    expect(getProducts).toHaveBeenNthCalledWith(1, {
      outlet_id: "outlet-1",
      limit: PAGE_SIZE,
      offset: 0,
    });
    expect(getProducts).toHaveBeenNthCalledWith(2, {
      outlet_id: "outlet-1",
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
    });
  });

  it("preserves order across the page boundary", async () => {
    const result = await fetchAllProducts(server(catalog(213)), "outlet-1");
    expect(result[0].name).toBe("Product 0");
    expect(result[199].name).toBe("Product 199");
    expect(result[200].name).toBe("Product 200");
    expect(result[212].name).toBe("Product 212");
  });

  it("stops after one request when the catalog fits in a page", async () => {
    const getProducts = server(catalog(50));

    const result = await fetchAllProducts(getProducts, "outlet-1");

    expect(result).toHaveLength(50);
    expect(getProducts).toHaveBeenCalledTimes(1);
  });

  it("handles a catalog that is an exact multiple of the page size", async () => {
    // 200 products: the first page is full, so it must ask again and get an
    // empty page rather than assuming it is done.
    const getProducts = server(catalog(PAGE_SIZE));

    const result = await fetchAllProducts(getProducts, "outlet-1");

    expect(result).toHaveLength(PAGE_SIZE);
    expect(getProducts).toHaveBeenCalledTimes(2);
  });

  it("handles an empty catalog", async () => {
    const getProducts = server([]);
    expect(await fetchAllProducts(getProducts, "outlet-1")).toEqual([]);
    expect(getProducts).toHaveBeenCalledTimes(1);
  });

  it("lets a failure propagate instead of returning a partial catalog quietly", async () => {
    const getProducts = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(fetchAllProducts(getProducts, "outlet-1")).rejects.toThrow("offline");
  });

  it("tolerates a non-array response without throwing mid-sale", async () => {
    const getProducts = vi.fn().mockResolvedValue(null);
    expect(await fetchAllProducts(getProducts, "outlet-1")).toEqual([]);
  });

  it("stops at the page ceiling and says so, rather than looping forever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A server that always returns a full page — the termination condition
    // never fires, so only the backstop can end this.
    const getProducts = vi.fn(async ({ limit }) => catalog(limit));

    const result = await fetchAllProducts(getProducts, "outlet-1");

    expect(getProducts).toHaveBeenCalledTimes(MAX_PAGES);
    expect(result).toHaveLength(MAX_PAGES * PAGE_SIZE);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/may be truncated/));
  });

  it("accepts a smaller page size for callers that want one", async () => {
    const getProducts = server(catalog(25));

    const result = await fetchAllProducts(getProducts, "outlet-1", { pageSize: 10 });

    expect(result).toHaveLength(25);
    expect(getProducts).toHaveBeenCalledTimes(3);
  });
});
