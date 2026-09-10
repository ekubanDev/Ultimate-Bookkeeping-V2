# Ultimate Bookkeeping v2 — Data Model & Offline-Write Contract
**Drafted by:** Kwame (Architect) & Efua (Backend) — Tesseract Holdings virtual dev-team org
**Status:** Draft for review — not yet implementation-ready until Cro signs off

---

## 1. Scope of this document

This covers the two pieces that need to be nailed down before any code gets written:

1. The **core Postgres data model** for the financial system of record.
2. The **offline-write contract** between the Outlet app and the FastAPI backend — the exact shape of how a POS sale (or stock/expense entry) survives no connectivity and lands correctly, exactly once, in Postgres.

Everything else (admin console screens, reports UI, AI features) builds on top of this once it's settled.

---

## 2. Core Data Model (Postgres)

Design principles: every financial mutation is a row in an append-friendly ledger-style table wherever possible (never overwrite history), foreign keys are real and enforced, money is `NUMERIC(12,2)` — never float.

### 2.1 `outlets`
| Column | Type | Notes |
|---|---|---|
| id | uuid, PK | |
| admin_id | uuid, FK → users.id | owning admin |
| name | text | |
| location | text | nullable |
| created_at | timestamptz | |

### 2.2 `users`
| Column | Type | Notes |
|---|---|---|
| id | uuid, PK | mirrors Firebase Auth UID |
| role | enum('admin','outlet_manager') | |
| outlet_id | uuid, FK → outlets.id | nullable, set for outlet_manager |
| created_by | uuid, FK → users.id | nullable, admin who created this manager |
| display_name | text | nullable |
| is_active | boolean, NOT NULL, server default true | server-controlled account revocation switch — a disabled user gets `403 USER_DISABLED` on every request, regardless of a still-valid Firebase token |
| created_at | timestamptz | |

### 2.3 `products`
| Column | Type | Notes |
|---|---|---|
| id | uuid, PK | |
| admin_id | uuid, FK → users.id | |
| sku | text | |
| name | text | |
| unit_price | numeric(12,2) | |
| min_stock | integer | |
| created_at | timestamptz | |

### 2.4 `stock_levels`
| Column | Type | Notes |
|---|---|---|
| id | uuid, PK | |
| product_id | uuid, FK → products.id | |
| outlet_id | uuid, FK → outlets.id | |
| quantity | integer | current on-hand, derived from stock_movements but cached here for fast reads |
| updated_at | timestamptz | |
| UNIQUE(product_id, outlet_id) | | |

### 2.5 `stock_movements` (append-only ledger)
| Column | Type | Notes |
|---|---|---|
| id | uuid, PK | |
| product_id | uuid, FK → products.id | |
| outlet_id | uuid, FK → outlets.id | |
| delta | integer | positive (restock) or negative (sale/adjustment) |
| reason | enum('sale','restock','adjustment','transfer') | |
| reference_id | uuid | nullable — points to sales.id, purchase_orders.id, etc. |
| client_id | text | idempotency key, see §3.3 |
| created_by | uuid, FK → users.id | |
| created_at | timestamptz | |

### 2.6 `sales` (append-only)
| Column | Type | Notes |
|---|---|---|
| id | uuid, PK | |
| outlet_id | uuid, FK → outlets.id | |
| client_id | text, UNIQUE | idempotency key from the device that recorded it |
| subtotal_amount | numeric(12,2) | server-computed sum of line_totals before discount/tax; stored rather than derived at read time so reports never disagree with what was committed, see §3.7 |
| total_amount | numeric(12,2) | server-computed, never accepted from the client, see §3.7 |
| tax_amount | numeric(12,2) | client-submitted and trusted — tax authority is deliberately out of scope for this rebuild |
| discount_type | enum('percentage','fixed') | how the cashier entered the discount |
| discount_value | numeric(12,2) | raw cashier input; 0.00–100.00 when discount_type='percentage' (not a money amount — column reused for decimal precision only), a GHS amount when discount_type='fixed' |
| discount_amount | numeric(12,2) | server-computed money discount actually applied — never accepted from the client, see §3.7 |
| payment_method | text | |
| status | enum('completed','voided') | |
| created_by | uuid, FK → users.id | |
| created_at | timestamptz | server-assigned, not client-assigned |
| device_recorded_at | timestamptz | client-side timestamp — for audit, never used for ordering logic |

### 2.7 `sale_line_items`
| Column | Type | Notes |
|---|---|---|
| id | uuid, PK | |
| sale_id | uuid, FK → sales.id | |
| product_id | uuid, FK → products.id | |
| quantity | integer | |
| unit_price | numeric(12,2) | the price actually charged for this line — persisted verbatim from the client's submitted_unit_price; never retroactively repriced from the catalog at sync time |
| catalog_unit_price_at_sale | numeric(12,2) | the outlet's live products.unit_price at the moment this line was committed server-side — audit/variance comparison only, never used in money math |
| price_variance_flagged | boolean | true when abs(unit_price − catalog_unit_price_at_sale) exceeds the tolerance in §3.7; never blocks the sale |
| line_total | numeric(12,2) | |

### 2.8 `expenses`, `liabilities`, `settlements`
Same append-only-ledger shape as `sales` — each gets `id`, `outlet_id`, `client_id` (unique, for offline-originated entries), `amount`, `status`, `created_by`, `created_at`. Full column lists deferred to implementation — the pattern above is the template; no need to relitigate it three more times in this doc.

---

## 3. Offline-Write Contract (Outlet App ↔ FastAPI)

This is the part that actually protects the "sale can never fail to record" requirement Ama set.

### 3.1 The boundary
The Outlet app **never writes to Postgres directly, online or offline.** Every mutation — online or queued — is a POST to a FastAPI endpoint. Firestore/local IndexedDB is a client-side cache and offline queue only, never a second source of truth for financial state.

### 3.2 The intent object
When the outlet app performs any financial write (sale, expense, restock adjustment), it constructs an **intent** locally, immediately, before knowing whether it has connectivity:

```json
{
  "client_id": "outlet-7f3a-1234-9c21",   // UUID generated on-device, once, at creation
  "type": "sale",
  "payload": {
    "outlet_id": "...",
    "line_items": [{ "product_id": "...", "quantity": 2, "unit_price": 15.00 }],
    "payment_method": "mobile_money",
    "device_recorded_at": "2026-08-31T18:42:03Z"
  }
}
```

- **Online:** the intent is POSTed immediately to `POST /api/sales`.
- **Offline:** the intent is written to the local IndexedDB queue immediately, shown in the UI as "recorded, syncing," and POSTed automatically the moment connectivity returns.

The UI treats a queued intent as a completed sale from the cashier's perspective — that's the whole point. It only escalates to the user if a sync later comes back as a genuine rejection (see §3.4), which should be rare.

### 3.3 Idempotency
`client_id` is generated **once**, on-device, at the moment of intent creation — not regenerated on retry. The `sales.client_id` column has a `UNIQUE` constraint. If the same intent gets POSTed twice (flaky reconnect double-fire, app relaunch replaying an unsent queue item), the second insert hits the unique constraint, and the endpoint returns the **original** result idempotently rather than erroring or duplicating. Same pattern applies to `stock_movements`, `expenses`, `liabilities` entries generated offline.

### 3.4 Server-side processing
On receipt, the endpoint:
1. Checks `client_id` for an existing row — if found, returns that record's result (idempotent replay), no-op.
2. Otherwise, opens a single Postgres transaction:
   - Insert into `sales` + `sale_line_items`
   - Insert corresponding negative-delta rows into `stock_movements`
   - Update `stock_levels` cache
   - Commit — all or nothing.
3. If the transaction fails for a real reason (e.g. product no longer exists), the response is a structured rejection the client can surface plainly to the user — this is the one case where "recorded, syncing" has to become a visible error, and it should be handled with an explicit resolution flow (edit and resubmit), not a silent drop.

### 3.5 Ordering
`created_at` is **server-assigned** at transaction commit time, not taken from the device. `device_recorded_at` is stored alongside for audit/dispute purposes only. This means a sale queued offline for six hours and synced later gets a `created_at` reflecting when it actually landed in the ledger — reports and reconciliation always use `created_at`; nothing in the system relies on client clocks for ordering.

### 3.6 What's explicitly out of scope for offline
Per Ama's earlier call: only **sales, stock movements/adjustments, and expense entry** get the offline queue. Reports, dashboards, settlements, and all admin-console actions are online-only with a clear "you're offline" state — no queue, no sync logic, no idempotency concerns for those paths. Keeping this boundary tight is what keeps the sync layer maintainable.

### 3.7 Price & discount integrity
Nana's security review flagged that `total_amount` was being computed entirely from client-supplied prices — a skimming vector (a compromised or tampered device could under-report the price charged and pocket the difference). This section is the fix, per Ama's finalized pricing spec. POS is catalog-only for this rebuild — `product_id` is required on every line item; there is no free-text/non-catalog line-item flow. Tax stays out of scope: `tax_amount` remains client-submitted and trusted, unchanged.

**Verbatim persist, never retroactively repriced.** `sale_line_items.unit_price` is persisted exactly as the client's `submitted_unit_price`, once, at insert time. A completed, paid sale is never repriced after the fact — not at sync time, not later — even when a subsequent catalog price change would make the original price look "wrong." What the cashier actually charged is what gets recorded, permanently.

**Server-only money computation.** `subtotal_amount`, `discount_amount`, and `total_amount` are computed server-side from the persisted line items and `discount_type`/`discount_value`. None of the three is ever accepted from the client, even if present in the request body.

**Computation order** (server-side, exactly once, in this order):
1. `line_total = quantity × unit_price` — exact, no intermediate rounding.
2. `subtotal_amount = sum(line_total)` across all line items.
3. Discount:
   - `discount_type = 'fixed'` → `discount_amount = min(discount_value, subtotal_amount)` (a discount can never exceed the subtotal it's applied to).
   - `discount_type = 'percentage'` → `discount_amount = round_half_up(subtotal_amount × discount_value / 100, 2dp)` — computed **once**, against the subtotal, never per-line and never applied twice.
4. `total_amount = subtotal_amount − discount_amount + tax_amount`, floored at `0.00`.

**Validation.** `discount_value` outside `0.00`–`100.00` when `discount_type = 'percentage'` → `422 VALIDATION_ERROR`.

**Price-variance flagging.** `price_variance_flagged := abs(unit_price − catalog_unit_price_at_sale) > max(2% of catalog_unit_price_at_sale, GHS 0.50)`. Ama's reasoning for the hybrid tolerance: a pure percentage threshold floods the review queue with pesewa-level rounding noise on cheap goods, while a pure flat-amount threshold hides real price overrides on expensive goods — the `max()` of both catches genuine outliers at both ends without over-flagging. This is a starting value, to be revisited once ~4 weeks of production flagged-queue data is available.

Flagging is purely observational: it never blocks, delays, discounts, or otherwise alters a sale — it only marks the line item for later human review. The admin-facing review queue that consumes `price_variance_flagged` lives in `/apps/admin` and is out of scope for this repo.

### 3.8 Local queue entry states
The Outlet app's local queue (`packages/offline-queue`) tracks each entry through the following states, persisted in IndexedDB (`QueueEntryState`, `packages/offline-queue/types.ts`):

| State | Meaning |
|---|---|
| `queued` | Persisted, waiting for (or between retries of) dispatch. |
| `syncing` | A dispatch attempt is in flight right now. |
| `synced` | Server accepted the write — either a fresh insert or an idempotent replay; §3.4 treats both as success. |
| `failed` | Server returned a non-retryable rejection (§3.4) — needs human resolution (edit-and-resubmit or explicit discard), not a silent drop. |
| `discarded` | User explicitly abandoned a `failed` entry. Kept for audit — never hard-deleted — and excluded from all future dispatch/flush. |
| `blocked_identity_mismatch` | Held because the currently signed-in user differs from the entry's creator — see §3.11. Never dispatched while blocked; resolves automatically. |

### 3.9 Response retention
A successful dispatch now stores the full parsed server response body on the queue entry (`last_response`), alongside the `synced` state transition and `synced_at` timestamp. Previously the response was discarded the moment dispatch resolved, which meant server-computed/returned fields that only exist once a write has actually landed — notably `price_variance_flagged` (§3.7) — were unreachable from the UI entirely, even for a write the app itself had just submitted. `last_response` is `null` until a dispatch on that entry actually succeeds.

### 3.10 Retention pruning
Nana's security review flagged that, without pruning, an outlet's entire sale/stock/expense history — amounts, categories, notes — sat indefinitely in plaintext in IndexedDB on a shared, often low-cost Android POS device, readable via DevTools by anyone with local access.

Terminal entries (`synced`, `discarded`) are now pruned after a retention window, `RETENTION_WINDOW_MS` (`packages/offline-queue/index.js`, default **48 hours**), measured from the entry's terminal timestamp (`synced_at` or `discarded_at`). The window is deliberately long enough to survive a bad-connectivity stretch spanning a full weekend closure — a manager checking "did yesterday's sales sync?" the next business day still finds the evidence — while bounding how much financial history ever sits in local storage at once.

Pruning runs at the end of every successful `flush()` pass and once at outlet-app startup — not on a recurring timer, to avoid competing with the event loop on low-powered shared devices for no real benefit.

`queued`, `syncing`, `failed`, and `blocked_identity_mismatch` entries are **never** pruned, at any age — these represent unsynced money and must never disappear silently.

### 3.11 Acting-user binding
Each queue entry records the acting user's id at enqueue time (`created_by`, sourced from the signed-in user — never a credential or token, an attribution binding only).

At dispatch time, if a *different*, positively-identified user is currently signed in on the device than the entry's `created_by`, the entry is **not** submitted — this would misattribute `created_by` server-side to the wrong person — and it is **not** silently dropped either. Instead it moves to `blocked_identity_mismatch` (§3.8) and is held, unsubmitted, until the original creator signs back in on that device, at which point it automatically returns to `queued` and rejoins the normal FIFO dispatch flow. This reconciliation check runs at the top of every `flush()` pass.

An entry with no known `created_by` (e.g. the offline-queue used outside an authenticated context, or a pre-migration entry) is never subject to this check — absence of identity information never blocks a dispatch, preserving backward compatibility.

---

## 4. Open items before implementation starts

- [ ] Final column lists for `expenses`, `liabilities`, `settlements` (Efua)
- [ ] Firestore migration script scoping — historical data cutover plan (Efua)
- [ ] Managed Postgres provider decision confirmed (leaning Supabase — Efua's recommendation, pending Yaw's infra/cost sign-off)
- [ ] Row-level security policy design if Supabase RLS is used (Nana)
