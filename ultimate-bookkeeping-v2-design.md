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
| display_name | text | |
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
| total_amount | numeric(12,2) | |
| tax_amount | numeric(12,2) | |
| discount_amount | numeric(12,2) | |
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
| unit_price | numeric(12,2) | price at time of sale, not a live product lookup |
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

---

## 4. Open items before implementation starts

- [ ] Final column lists for `expenses`, `liabilities`, `settlements` (Efua)
- [ ] Firestore migration script scoping — historical data cutover plan (Efua)
- [ ] Managed Postgres provider decision confirmed (leaning Supabase — Efua's recommendation, pending Yaw's infra/cost sign-off)
- [ ] Row-level security policy design if Supabase RLS is used (Nana)
