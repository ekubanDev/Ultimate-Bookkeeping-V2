import { useState } from "react";
import { Button } from "@ub/shared-ui";

import { useAuth } from "../auth/AuthContext.jsx";
import { useSyncStatus } from "../features/sync-status/useSyncStatus.js";

/**
 * AppHeader — who is signed in, and the only way to stop being signed in.
 *
 * WHY THIS EXISTS. AuthContext has exposed `signOut` since it was written and
 * nothing ever called it, so the app had no sign-out at all. That was not
 * merely inconvenient: the offline queue has a `blocked_identity_mismatch`
 * state, SyncBanner tells the user "N item(s) recorded by another user — they
 * must sign in to sync", and the support runbook says "have that person sign
 * in on this device". None of that was possible. The documented recovery for
 * identity-blocked entries required a control that did not exist, and the
 * only workaround — clearing site data — destroys the unsynced queue, which
 * is the one genuine data-loss path in the whole system.
 *
 * Showing the signed-in name is half the fix. "Recorded by another user" is
 * unactionable if nobody can see which user they currently are.
 *
 * SIGNING OUT WITH WORK IN THE QUEUE is allowed but confirmed. Queued entries
 * are NOT lost — they stay in IndexedDB and are re-dispatched when their
 * author signs back in (offline-queue's created_by check). But they will not
 * sync under anyone else, so a handover mid-queue means those sales sit until
 * that person returns. The cashier is told that plainly rather than finding
 * out from a banner afterwards.
 */
export default function AppHeader() {
  const { profile, signOut } = useAuth();
  const { queuedCount, hasFailures, failedEntries } = useSyncStatus();
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Anything not yet accepted by the server travels with its author.
  const unsyncedCount = queuedCount + (hasFailures ? failedEntries.length : 0);

  if (!profile) return null;

  const handleSignOutClick = () => {
    if (unsyncedCount > 0) {
      setConfirming(true);
      return;
    }
    void doSignOut();
  };

  const doSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // If sign-out failed the user is still here and must be able to retry;
      // if it succeeded this component unmounts and the state is discarded.
      setSigningOut(false);
      setConfirming(false);
    }
  };

  return (
    <header className="ub-app-header">
      <div className="ub-app-header__identity">
        <span className="ub-app-header__name">
          {profile.display_name || "Signed in"}
        </span>
        {unsyncedCount > 0 && (
          <span className="ub-app-header__pending">
            {unsyncedCount} not yet synced
          </span>
        )}
      </div>

      <Button
        variant="ghost"
        onClick={handleSignOutClick}
        disabled={signingOut}
        aria-label={`Sign out ${profile.display_name || ""}`.trim()}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </Button>

      {confirming && (
        <div className="ub-app-header__confirm" role="alertdialog" aria-label="Confirm sign out">
          <p className="ub-app-header__confirm-text">
            <strong>{unsyncedCount} item(s) have not reached the server.</strong>{" "}
            They are saved on this phone and are not lost, but they can only be
            sent by <strong>{profile.display_name || "this user"}</strong>. If
            you sign out, they will wait here until that person signs back in.
          </p>
          <div className="ub-app-header__confirm-actions">
            <Button variant="danger" onClick={doSignOut} disabled={signingOut}>
              Sign out anyway
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Stay signed in
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
