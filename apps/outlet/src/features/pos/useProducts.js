import { useCallback, useEffect, useState } from "react";
import { getProducts } from "@ub/api-client";

/**
 * useProducts — fetches the product catalog for one outlet.
 *
 * Reads are not offline-eligible (CLAUDE.md constraint: offline-first
 * applies only to sales, stock adjustments, expenses) — this is a plain
 * GET call, not queued. If the device is offline the fetch will fail and
 * `error` will be set; callers can surface a plain message.
 *
 * Maps 1:1 to GET /api/v1/products (tenant-scoped server-side, ordered by
 * name). Mirrors useStockLevels.js's shape/conventions so the two read
 * hooks are consistent.
 *
 * @param {string|null|undefined} outletId
 * @returns {{ products: Array, loading: boolean, error: Error|null, refetch: () => void }}
 */
export function useProducts(outletId) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // A counter that bumps on every refetch() call to re-trigger the effect.
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!outletId) return;

    let cancelled = false;

    setLoading(true);
    setError(null);

    getProducts({ outlet_id: outletId })
      .then((data) => {
        if (!cancelled) {
          setProducts(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [outletId, tick]);

  return { products, loading, error, refetch };
}
