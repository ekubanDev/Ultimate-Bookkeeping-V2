import { useSyncStatus } from "./useSyncStatus.js";

/**
 * SyncBanner — "3 items syncing" / "sync failed, resolve" UI.
 *
 * Owns: reading global queue status via useSyncStatus and rendering the
 * syncing/failed states from design doc §3.4.
 * Does NOT own: retrying or resolving — per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §3, that's a user action
 * routed back through offline-queue, not this component.
 */
export default function SyncBanner() {
  const { queuedCount, hasFailures, failedEntries } = useSyncStatus();

  if (!queuedCount && !hasFailures) {
    return null;
  }

  return (
    <div className="ub-sync-banner" role="status">
      {hasFailures ? (
        <span className="ub-sync-banner__failed">
          {failedEntries.length} item(s) failed to sync — resolve needed
        </span>
      ) : (
        <span className="ub-sync-banner__syncing">
          {queuedCount} item(s) syncing…
        </span>
      )}
    </div>
  );
}
