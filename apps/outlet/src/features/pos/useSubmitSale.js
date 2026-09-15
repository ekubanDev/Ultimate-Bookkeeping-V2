import { useCallback, useState } from "react";
import { generateClientId } from "@ub/offline-queue/idempotency.js";
import { enqueue, QuotaExceededStorageError } from "@ub/offline-queue";
import { useAuth } from "../../auth/AuthContext.jsx";

/**
 * buildSaleIntent — pure builder for the offline-queue Intent wrapping a
 * SaleRequest. Per tesseract-fp-guide.md §2/§4: no `Date.now()`/
 * `generateClientId()` calls inside — `deviceRecordedAt` and `clientId` are
 * inputs, generated at the edge (in submitSale below) and passed in. Given
 * the same arguments this always returns the same intent, so it's directly
 * unit-testable without touching IndexedDB or the clock.
 *
 * Cart-level discount is now a type+value pair (percentage or fixed GHS
 * amount), mirroring v1's `applyDiscount()` UX — a single pre-computed
 * `discount_amount` lost that semantic. Every line item carries its
 * catalog-seeded `submitted_unit_price`, persisted verbatim server-side;
 * the server, not this builder, is authoritative for
 * subtotal/discount/total (ultimate-bookkeeping-v2-api-contracts.md §2).
 *
 * @param {Array<{ product_id: string, quantity: number, submitted_unit_price: string }>} lineItems
 * @param {{
 *   outletId: string,
 *   paymentMethod: string,
 *   discountType?: import('@ub/shared-types').DiscountType,
 *   discountValue?: string,
 *   taxAmount?: string,
 *   deviceRecordedAt: string,
 *   clientId: string,
 * }} params
 * @returns {{ client_id: string, type: 'sale', payload: import('@ub/shared-types').SaleRequest }}
 */
export function buildSaleIntent(
  lineItems,
  {
    outletId,
    paymentMethod,
    discountType = "fixed",
    discountValue = "0.00",
    taxAmount = "0.00",
    deviceRecordedAt,
    clientId,
  }
) {
  /** @type {import('@ub/shared-types').SaleRequest} */
  const payload = {
    client_id: clientId,
    outlet_id: outletId,
    line_items: lineItems,
    payment_method: paymentMethod,
    discount_type: discountType,
    discount_value: discountValue,
    tax_amount: taxAmount,
    device_recorded_at: deviceRecordedAt,
  };

  return {
    client_id: clientId,
    type: "sale",
    payload,
  };
}

/**
 * useSubmitSale — builds the sale intent and hands it to the shared
 * offline-queue. Per ultimate-bookkeeping-v2-outlet-ui-plan.md §3: owns
 * building the `intent` object and exposing submission `status`. Does NOT
 * own cart state (that's useCart) or UI rendering.
 *
 * Maps 1:1 to POST /api/v1/sales (ultimate-bookkeeping-v2-api-contracts.md §2).
 */
export function useSubmitSale() {
  const { profile } = useAuth();
  // 'submitting' is IN FLIGHT (enqueue() has not resolved yet). 'queued' is
  // a TERMINAL SUCCESS: the intent is durably persisted and will sync when
  // the network returns. Keeping them distinct matters offline, where
  // 'queued' is the only outcome a sale can ever reach — collapsing the two
  // made the confirm button, which disables while "in flight", stay disabled
  // forever after the first offline sale, so a cashier could record exactly
  // one sale per session with no network. Online the two states were
  // indistinguishable only by luck: dispatch usually completed fast enough
  // that enqueue() returned 'synced'.
  const [status, setStatus] = useState(
    /** @type {'idle'|'submitting'|'queued'|'synced'|'failed'|'storage_full'} */ ("idle")
  );
  const [error, setError] = useState(null);

  /**
   * Clears status/error back to 'idle'. Call when STARTING a new sale (see
   * PosScreen's checkout button) so a terminal state from the previous sale
   * — a stale 'failed' banner, or a 'queued' that is no longer relevant —
   * doesn't carry into the next one.
   */
  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  /**
   * @param {{
   *   outletId: string,
   *   lineItems: Array<{ product_id: string, quantity: number, submitted_unit_price: string }>,
   *   paymentMethod: string,
   *   discountType?: import('@ub/shared-types').DiscountType,
   *   discountValue?: string,
   *   taxAmount?: string,
   * }} params
   */
  const submitSale = useCallback(async (params) => {
    // client_id and device_recorded_at are the two "edge" effects
    // (tesseract-fp-guide.md §2) — generated exactly once here, at intent
    // creation, then handed to the pure buildSaleIntent() as plain inputs.
    // client_id is never regenerated if this same intent is retried by the
    // offline-queue.
    const clientId = generateClientId();
    const deviceRecordedAt = new Date().toISOString();

    const intent = buildSaleIntent(params.lineItems, {
      outletId: params.outletId,
      paymentMethod: params.paymentMethod,
      discountType: params.discountType,
      discountValue: params.discountValue,
      taxAmount: params.taxAmount,
      deviceRecordedAt,
      clientId,
    });

    // Set BEFORE awaiting enqueue(): this is what the confirm button gates
    // on, and it is the double-tap guard (PosScreen.test.jsx, Adjoa QA #5) —
    // a second tap arriving before enqueue() resolves must not build a
    // second intent with a second client_id.
    setStatus("submitting");
    setError(null);

    try {
      // enqueue() persists write-first and returns fast (design doc §3.2) —
      // its `state` is almost always 'queued' here since dispatch happens
      // in the background; 'syncing' collapses to the same UI status.
      // `createdBy` binds the acting user's id at enqueue time (Nana's
      // security-review finding) so a later dispatch — possibly minutes or
      // hours later, on a shared device, after a shift change — can never
      // silently submit this sale under whoever happens to be signed in by
      // then. See @ub/offline-queue's dispatchEntry/reconcileIdentityBlocks.
      const entry = await enqueue(intent, { createdBy: profile?.id ?? null });
      setStatus(entry?.state === "syncing" ? "queued" : entry?.state ?? "queued");
      return entry;
    } catch (err) {
      // A quota failure here means enqueue() itself rejected — unlike a
      // post-dispatch failure (which at least leaves a 'failed' entry in
      // the queue for retry/discard), NOTHING was durably persisted: no
      // client_id, no record, the sale is simply gone. That's a materially
      // different, more urgent condition than a normal submission failure
      // ("check the details and try again" would be actively misleading —
      // editing details cannot fix a full disk), so it gets its own status
      // rather than collapsing into 'failed'. See
      // @ub/offline-queue/db.js#QuotaExceededStorageError and
      // index.js#persistAndNotify's emergency-prune-and-retry, which is
      // attempted before this ever surfaces.
      setStatus(err instanceof QuotaExceededStorageError ? "storage_full" : "failed");
      setError(err);
      throw err;
    }
  }, [profile?.id]);

  return { submitSale, status, error, reset };
}
