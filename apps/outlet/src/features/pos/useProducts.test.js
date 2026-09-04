import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useProducts } from "./useProducts.js";

const getProductsMock = vi.fn();
vi.mock("@ub/api-client", () => ({
  getProducts: (...args) => getProductsMock(...args),
  // other api-client exports not used by this hook
}));

const MOCK_PRODUCTS = [
  { id: "prod-1", sku: "RICE5", name: "Rice 5kg", unit_price: "75.00", min_stock: 10 },
  { id: "prod-2", sku: null, name: "Sachet Water", unit_price: "5.00", min_stock: null },
];

beforeEach(() => {
  getProductsMock.mockReset();
});

describe("useProducts", () => {
  it("starts with loading=true and products=[] while the fetch is in flight", () => {
    // Never-resolving promise simulates a slow network.
    getProductsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useProducts("outlet-1"));
    expect(result.current.loading).toBe(true);
    expect(result.current.products).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("fetches with the correct outlet_id and returns products on success", async () => {
    getProductsMock.mockResolvedValue(MOCK_PRODUCTS);
    const { result } = renderHook(() => useProducts("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getProductsMock).toHaveBeenCalledWith({ outlet_id: "outlet-1" });
    expect(result.current.products).toEqual(MOCK_PRODUCTS);
    expect(result.current.error).toBeNull();
  });

  it("sets error and clears products on fetch failure", async () => {
    getProductsMock.mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useProducts("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error.message).toBe("network error");
    expect(result.current.products).toEqual([]);
  });

  it("resolves to an empty catalog without error when the outlet has no products", async () => {
    getProductsMock.mockResolvedValue([]);
    const { result } = renderHook(() => useProducts("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.products).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("does not fetch when outletId is null", () => {
    renderHook(() => useProducts(null));
    expect(getProductsMock).not.toHaveBeenCalled();
  });

  it("does not fetch when outletId is undefined", () => {
    renderHook(() => useProducts(undefined));
    expect(getProductsMock).not.toHaveBeenCalled();
  });

  it("re-fetches when outletId changes", async () => {
    getProductsMock.mockResolvedValue(MOCK_PRODUCTS);
    const { result, rerender } = renderHook(({ id }) => useProducts(id), {
      initialProps: { id: "outlet-1" },
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getProductsMock).toHaveBeenCalledWith({ outlet_id: "outlet-1" });

    rerender({ id: "outlet-2" });
    await waitFor(() => expect(getProductsMock).toHaveBeenCalledTimes(2));
    expect(getProductsMock).toHaveBeenLastCalledWith({ outlet_id: "outlet-2" });
  });

  it("refetch() triggers a new fetch without changing outletId", async () => {
    getProductsMock.mockResolvedValue(MOCK_PRODUCTS);
    const { result } = renderHook(() => useProducts("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getProductsMock).toHaveBeenCalledTimes(1);

    result.current.refetch();
    await waitFor(() => expect(getProductsMock).toHaveBeenCalledTimes(2));
    expect(result.current.products).toEqual(MOCK_PRODUCTS);
  });

  it("coerces a non-array API response to an empty array", async () => {
    getProductsMock.mockResolvedValue(null);
    const { result } = renderHook(() => useProducts("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.products).toEqual([]);
  });
});
