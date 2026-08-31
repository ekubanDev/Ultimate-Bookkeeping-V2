import { useEffect, useState } from "react";
import { getQueueSnapshot, onReconnect } from "@ub/offline-queue";

/**
 * useSyncStatus — reads the global offline-queue status for SyncBanner.
 *
 * Owns: subscribing to queue snapshot/updates and deriving the aggregate
 * counts SyncBanner renders ("N syncing" / "sync failed").
 * Does NOT own: retrying or resolving failed entries — that's a user
 * action routed back through offline-queue directly (per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §3).
 */
export function useSyncStatus() {
  const [entries, setEntries] = useState(/** @type {import('@ub/offline-queue/types').QueueEntry[]} */ ([]));
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    getQueueSnapshot()
      .then((snapshot) => {
        if (!cancelled) setEntries(snapshot);
      })
      .catch((err) => {
        // TODO(offline-queue): getQueueSnapshot() is currently a stub — this
        // catch keeps the scaffold from crashing until it's implemented.
        if (!cancelled) setLoadError(err);
      });

    // TODO(offline-queue): onReconnect() is currently a stub — once
    // implemented it should invoke the callback below on every queue
    // status change, not just on reconnect.
    const unsubscribe = onReconnect?.((updatedEntry) => {
      setEntries((prev) =>
        prev.map((e) =>
          e.intent.client_id === updatedEntry.intent.client_id
            ? updatedEntry
            : e
        )
      );
    });

    return () => {
      cancelled = true;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  const queuedCount = entries.filter((e) => e.status === "queued").length;
  const failedEntries = entries.filter((e) => e.status === "failed");

  return {
    entries,
    queuedCount,
    failedEntries,
    hasFailures: failedEntries.length > 0,
    loadError,
  };
}
