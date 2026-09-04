import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useStockLevels } from "./useStockLevels.js";

const getStockLevelsMock = vi.fn();
vi.mock("@ub/api-client", () => ({
  getStockLevels: (...args) => getStockLevelsMock(...args),
  // other api-client exports not used by this hook
}));

const MOCK_LEVELS = [
  {
    product_id: "prod-1",
    product_name: "Rice 5kg",
    sku: "RICE5",
    quantity: 10,
    updated_at: "2026-09-01T00:00:00Z",
  },
  {
    product_id: "prod-2",
    product_name: "Sachet Water",
    sku: "WATER",
    quantity: 0,
    updated_at: "2026-09-01T00:00:00Z",
  },
];

beforeEach(() => {
  getStockLevelsMock.mockReset();
});

describe("useStockLevels", () => {
  it("starts with loading=true and levels=[] while the fetch is in flight", () => {
    // Never-resolving promise simulates a slow network.
    getStockLevelsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useStockLevels("outlet-1"));
    expect(result.current.loading).toBe(true);
    expect(result.current.levels).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("fetches with the correct outlet_id and returns levels on success", async () => {
    getStockLevelsMock.mockResolvedValue(MOCK_LEVELS);
    const { result } = renderHook(() => useStockLevels("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getStockLevelsMock).toHaveBeenCalledWith({ outlet_id: "outlet-1" });
    expect(result.current.levels).toEqual(MOCK_LEVELS);
    expect(result.current.error).toBeNull();
  });

  it("sets error and clears levels on fetch failure", async () => {
    getStockLevelsMock.mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useStockLevels("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error.message).toBe("network error");
    expect(result.current.levels).toEqual([]);
  });

  it("does not fetch when outletId is null", () => {
    renderHook(() => useStockLevels(null));
    expect(getStockLevelsMock).not.toHaveBeenCalled();
  });

  it("does not fetch when outletId is undefined", () => {
    renderHook(() => useStockLevels(undefined));
    expect(getStockLevelsMock).not.toHaveBeenCalled();
  });

  it("re-fetches when outletId changes", async () => {
    getStockLevelsMock.mockResolvedValue(MOCK_LEVELS);
    const { result, rerender } = renderHook(({ id }) => useStockLevels(id), {
      initialProps: { id: "outlet-1" },
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getStockLevelsMock).toHaveBeenCalledWith({ outlet_id: "outlet-1" });

    rerender({ id: "outlet-2" });
    await waitFor(() => expect(getStockLevelsMock).toHaveBeenCalledTimes(2));
    expect(getStockLevelsMock).toHaveBeenLastCalledWith({ outlet_id: "outlet-2" });
  });

  it("refetch() triggers a new fetch without changing outletId", async () => {
    getStockLevelsMock.mockResolvedValue(MOCK_LEVELS);
    const { result } = renderHook(() => useStockLevels("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getStockLevelsMock).toHaveBeenCalledTimes(1);

    result.current.refetch();
    await waitFor(() => expect(getStockLevelsMock).toHaveBeenCalledTimes(2));
    expect(result.current.levels).toEqual(MOCK_LEVELS);
  });

  it("coerces a non-array API response to an empty array", async () => {
    getStockLevelsMock.mockResolvedValue(null);
    const { result } = renderHook(() => useStockLevels("outlet-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.levels).toEqual([]);
  });
});
