import { useEffect, useState } from "react";
import { getQueueSnapshot, subscribe } from "@ub/offline-queue";

const EMPTY_SNAPSHOT = {
  counts: {
    queued: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
    discarded: 0,
    blocked_identity_mismatch: 0,
  },
  entries: [],
};

/**
 * useSyncStatus — reads the global offline-queue status for SyncBanner.
 *
 * Owns: subscribing to queue snapshot/updates (via offline-queue's
 * subscribe()) and deriving the aggregate counts SyncBanner renders
 * ("N syncing" / "sync failed"). No polling — subscribe() pushes a fresh
 * snapshot on every state transition.
 * Does NOT own: retrying or resolving failed entries — that's a user
 * action routed back through offline-queue directly (per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §3). Does NOT own: wiring the
 * 'online' reconnect listener — offline-queue.onReconnect() is initialized
 * once at app startup, in App.jsx.
 */
export function useSyncStatus() {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    getQueueSnapshot()
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      });

    const unsubscribe = subscribe((snap) => {
      if (!cancelled) setSnapshot(snap);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const entries = snapshot.entries;
  // "Syncing" from the cashier's perspective covers both 'queued' (waiting
  // for/between attempts) and 'syncing' (attempt in flight) — both mean
  // "not yet confirmed, don't worry the user yet".
  const queuedCount = (snapshot.counts.queued ?? 0) + (snapshot.counts.syncing ?? 0);
  const failedEntries = entries.filter((e) => e.state === "failed");

  // Entries held pending the original creator signing back in (Nana's
  // security-review finding — see @ub/offline-queue's dispatchEntry). This
  // needs a plain explanation ("they must sign in to sync"), same calm
  // register as the failed/syncing states — never dropped, never
  // misattributed, never a till-side alarm.
  const identityBlockedEntries = entries.filter((e) => e.state === "blocked_identity_mismatch");

  // Synced sales whose server response flagged a price variance
  // (design doc §3.7). Purely an admin-review signal — this is a *quiet*
  // marker, deliberately not styled/worded like the failed/blocked states.
  // Naturally bounded by offline-queue's retention pruning: once a synced
  // entry ages out (see RETENTION_WINDOW_MS), its marker disappears too.
  const varianceFlaggedEntries = entries.filter(
    (e) => e.state === "synced" && e.last_response?.price_variance_flagged === true
  );

  return {
    entries,
    queuedCount,
    failedEntries,
    hasFailures: failedEntries.length > 0,
    identityBlockedEntries,
    hasIdentityBlocked: identityBlockedEntries.length > 0,
    varianceFlaggedEntries,
    hasVarianceFlags: varianceFlaggedEntries.length > 0,
    loadError,
  };
}
