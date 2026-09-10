import { useSyncStatus } from "./useSyncStatus.js";

/**
 * SyncBanner — "3 items syncing" / "sync failed, resolve" UI. Also the
 * "sync/queue view" this app currently has, so it's where two other
 * calm, non-blocking signals surface (never a till-side alarm, never
 * interrupting the cashier — see PosScreen.jsx's checkout flow, which is
 * unaffected by any of this):
 *   - identity-mismatch holds (Nana's security-review finding): entries
 *     queued by a different, now-signed-out user, explained plainly.
 *   - price-variance flags (design doc §3.7): an admin-review signal only.
 *
 * Owns: reading global queue status via useSyncStatus and rendering the
 * syncing/failed/identity-blocked/variance states.
 * Does NOT own: retrying or resolving — per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §3, that's a user action
 * routed back through offline-queue, not this component.
 */
export default function SyncBanner() {
  const {
    queuedCount,
    hasFailures,
    failedEntries,
    hasIdentityBlocked,
    identityBlockedEntries,
    hasVarianceFlags,
    varianceFlaggedEntries,
  } = useSyncStatus();

  if (!queuedCount && !hasFailures && !hasIdentityBlocked && !hasVarianceFlags) {
    return null;
  }

  return (
    <div className="ub-sync-banner" role="status">
      {hasFailures && (
        <span className="ub-sync-banner__failed">
          {failedEntries.length} item(s) failed to sync — resolve needed
        </span>
      )}
      {hasIdentityBlocked && (
        <span className="ub-sync-banner__identity-blocked">
          {identityBlockedEntries.length} item(s) recorded by another user — they must sign
          in to sync
        </span>
      )}
      {!hasFailures && queuedCount > 0 && (
        <span className="ub-sync-banner__syncing">{queuedCount} item(s) syncing…</span>
      )}
      {hasVarianceFlags && (
        // Deliberately a plain, non-alarming note — not styled/worded like
        // the failed/blocked states above. Admin-review signal only, per
        // design doc §3.7: it never blocked, delayed, or altered the sale,
        // and it doesn't get to alarm the till after the fact either.
        <span className="ub-sync-banner__variance">
          {varianceFlaggedEntries.length} sale(s) flagged for admin price review
        </span>
      )}
    </div>
  );
}
