import { useMemo, useState } from "react";
import { Button } from "@ub/shared-ui";
import { retryEntry, discardEntry } from "@ub/offline-queue";
import { useSyncStatus } from "./useSyncStatus.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { useProducts } from "../pos/useProducts.js";
import { useStockLevels } from "../stock/useStockLevels.js";
import { useSubmitAdjustment } from "../stock/useSubmitAdjustment.js";
import { indexStockLevels } from "../pos/productStock.js";
import { planStockTopUp, indexProductNames } from "./planStockTopUp.js";

/**
 * SyncResolutionScreen — the resolution flow design.md §3.4 mandates
 * ("a structured rejection the client can surface plainly to the user...
 * handled with an explicit resolution flow, not a silent drop") and
 * §3.8's `failed` state docstring ("needs human resolution... not a silent
 * drop"). Before this (Adjoa QA bug #2), SyncBanner rendered "N item(s)
 * failed to sync — resolve needed" but nothing in the app ever called
 * @ub/offline-queue's retryEntry()/discardEntry() — a sale rejected for a
 * real reason (product deleted mid-shift, stock oversold by another
 * device) landed in 'failed', was deliberately exempt from retention
 * pruning (it's unsynced money — §3.10), and sat forever with no way to
 * act on it.
 *
 * Reachable from OutletNav's "Sync" tab (see App.jsx's /sync route).
 *
 * Owns: listing 'failed' entries with their stored `last_error`, and the
 * retry/discard actions themselves — both routed straight back through
 * @ub/offline-queue (retryEntry/discardEntry), same as this app's other
 * feature screens route submissions through the same package.
 * Does NOT own: computing what counts as "failed" (useSyncStatus, shared
 * with SyncBanner) or per-item sync-state chrome elsewhere in the app.
 *
 * SCOPE NOTE — deliberately deferred (see task writeup): editing a failed
 * entry's payload before resubmitting it (design.md §3.4's "edit and
 * resubmit"). retryEntry() already accepts an optional edited payload and
 * keeps the client_id unchanged, so the plumbing is ready, but no form UI
 * exists yet to build a new payload for an arbitrary failed sale/adjustment/
 * expense. Retry here always resubmits the entry byte-for-byte unchanged
 * (which is exactly right for a transient/environmental rejection, and
 * genuinely useless for e.g. "stock oversold" without a way to change the
 * quantity) — Discard is the escape hatch for the latter, with a plain note
 * below explaining the gap rather than a UI that quietly can't do what it
 * implies.
 */
export default function SyncResolutionScreen() {
  const { failedEntries } = useSyncStatus();
  const { profile } = useAuth();
  const outletId = profile?.outlet_id;
  // Only needed to name products and size the shortfall for the
  // INSUFFICIENT_STOCK flow; both tolerate failing (see planStockTopUp).
  const { products } = useProducts(outletId);
  const { levels, refetch: refetchLevels } = useStockLevels(outletId);
  const { submitAdjustment } = useSubmitAdjustment();
  const stockByProduct = useMemo(() => indexStockLevels(levels), [levels]);
  const namesByProduct = useMemo(
    () => indexProductNames(products, levels),
    [products, levels]
  );
  // Tracks which single entry currently has a retry/discard in flight, so
  // only that row's buttons disable — one slow action must never freeze the
  // whole list.
  const [pendingClientId, setPendingClientId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const handleRetry = async (clientId) => {
    setPendingClientId(clientId);
    setActionError(null);
    try {
      // Same client_id throughout — never regenerated (design doc §3.3) —
      // so if the original attempt secretly landed server-side despite the
      // rejection response we saw, the server's idempotency check still
      // collapses this into a safe replay rather than a duplicate.
      await retryEntry(clientId);
    } catch (err) {
      setActionError(err?.message || "Could not retry this entry. Check your connection and try again.");
    } finally {
      setPendingClientId(null);
    }
  };

  /**
   * Record the stock the shelf actually held, then resend the sale.
   *
   * This asserts that physical stock existed which the system never saw, so
   * it is applied only after the manager has seen the exact numbers (the row
   * renders the plan before this runs). Each adjustment goes through the same
   * offline-queue path as any other, with its own client_id, so it is
   * durable and idempotent in its own right.
   */
  const handleTopUpAndRetry = async (entry, plan) => {
    setPendingClientId(entry.client_id);
    setActionError(null);
    try {
      for (const line of plan) {
        await submitAdjustment({
          productId: line.product_id,
          outletId,
          delta: line.shortfall,
          reason: "adjustment",
        });
      }
      // Resend the ORIGINAL sale, unchanged and with its original client_id.
      await retryEntry(entry.client_id);
      refetchLevels?.();
    } catch (err) {
      setActionError(
        err?.message ||
          "Could not record the stock correction. Check your connection and try again."
      );
    } finally {
      setPendingClientId(null);
    }
  };

  const handleDiscard = async (clientId) => {
    // Explicit, deliberate abandonment (design.md §3.8) — confirm before an
    // irreversible-from-the-cashier's-perspective action (discardEntry
    // keeps it for audit, but it never syncs again after this).
    const confirmed =
      typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm("Discard this entry? It will not be synced or retried again.");
    if (!confirmed) return;

    setPendingClientId(clientId);
    setActionError(null);
    try {
      await discardEntry(clientId);
    } catch (err) {
      setActionError(err?.message || "Could not discard this entry.");
    } finally {
      setPendingClientId(null);
    }
  };

  return (
    <section className="ub-sync-resolution-screen">
      <h1>Sync</h1>

      {actionError ? (
        <p role="alert" className="ub-sync-resolution-screen__action-error">
          {actionError}
        </p>
      ) : null}

      {failedEntries.length === 0 ? (
        <p className="ub-sync-resolution-screen__empty">
          Nothing needs your attention — every recorded sale, stock adjustment, and expense has
          synced.
        </p>
      ) : (
        <>
          <p className="ub-sync-resolution-screen__intro">
            These were recorded on this device but rejected by the server — they will NOT sync on
            their own. Review why, then Retry (resend exactly as recorded) or Discard.
          </p>
          <ul className="ub-sync-resolution-screen__list">
            {failedEntries.map((entry) => (
              <FailedEntryRow
                key={entry.client_id}
                entry={entry}
                isPending={pendingClientId === entry.client_id}
                stockByProduct={stockByProduct}
                namesByProduct={namesByProduct}
                onRetry={() => handleRetry(entry.client_id)}
                onDiscard={() => handleDiscard(entry.client_id)}
                onTopUpAndRetry={handleTopUpAndRetry}
              />
            ))}
          </ul>
          <p className="ub-sync-resolution-screen__note">
            Editing an entry's details before retrying isn't supported yet — Retry always resends
            it exactly as originally recorded. If what actually happened needs to change (e.g. a
            different quantity), Discard this one and record a fresh entry instead.
          </p>
        </>
      )}
    </section>
  );
}

const TYPE_LABELS = {
  sale: "Sale",
  stock_adjustment: "Stock adjustment",
  expense: "Expense",
};

function FailedEntryRow({
  entry,
  isPending,
  stockByProduct,
  namesByProduct,
  onRetry,
  onDiscard,
  onTopUpAndRetry,
}) {
  // Plain Retry cannot help an INSUFFICIENT_STOCK rejection: the server
  // returned retryable:false and will reject an identical resend every time.
  // Discard is the only other option and it throws away a sale where money
  // changed hands. This is the third answer.
  const isStockShortfall =
    entry.type === "sale" && entry.last_error?.code === "INSUFFICIENT_STOCK";

  const plan = isStockShortfall
    ? planStockTopUp(entry.payload, stockByProduct, namesByProduct)
    : [];

  // A plan can come back empty when stock has since been restocked by
  // someone else — in which case a plain Retry genuinely will work now.
  const canTopUp = plan.length > 0;

  return (
    <li className="ub-sync-resolution-screen__item">
      <p className="ub-sync-resolution-screen__type">{TYPE_LABELS[entry.type] ?? entry.type}</p>
      <p className="ub-sync-resolution-screen__error">
        {entry.last_error?.message || "This entry was rejected and needs your attention."}
      </p>
      {entry.last_error?.code ? (
        <p className="ub-sync-resolution-screen__code">Reason code: {entry.last_error.code}</p>
      ) : null}

      {isStockShortfall && (
        <div className="ub-sync-resolution-screen__shortfall">
          {canTopUp ? (
            <>
              <p>
                This sale is recorded on this phone but the shop&rsquo;s stock
                records could not cover it. If the goods really did leave the
                shop, record what was actually on the shelf and send the sale
                again:
              </p>
              <ul className="ub-sync-resolution-screen__shortfall-list">
                {plan.map((line) => (
                  <li key={line.product_id}>
                    <strong>{line.name}</strong> — sold {line.requested}, records
                    showed {line.available}. Would record{" "}
                    <strong>+{line.shortfall}</strong>.
                  </li>
                ))}
              </ul>
              <p className="ub-sync-resolution-screen__shortfall-note">
                This adds a stock correction in your name. Only do it if the
                stock was genuinely there.
              </p>
            </>
          ) : (
            <p>
              Stock now covers this sale — someone has recorded stock since it
              was rejected. <strong>Retry</strong> should work.
            </p>
          )}
        </div>
      )}

      <div className="ub-sync-resolution-screen__actions">
        {isStockShortfall && canTopUp && (
          <Button
            variant="primary"
            onClick={() => onTopUpAndRetry?.(entry, plan)}
            disabled={isPending}
          >
            {isPending ? "Working…" : "Record stock and resend"}
          </Button>
        )}
        <Button
          variant={isStockShortfall && canTopUp ? "secondary" : "primary"}
          onClick={onRetry}
          disabled={isPending}
        >
          {isPending ? "Working…" : "Retry"}
        </Button>
        <Button variant="secondary" onClick={onDiscard} disabled={isPending}>
          Discard
        </Button>
      </div>
    </li>
  );
}
