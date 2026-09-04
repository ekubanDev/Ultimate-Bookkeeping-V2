# Ultimate Bookkeeping v2 — API Endpoint Contracts
**Drafted by:** Efua (Backend) — Tesseract Holdings virtual dev-team org
**Builds on:** `ultimate-bookkeeping-v2-design.md` (data model + offline-write contract)
**Status:** Draft for Kojo to build against — flag anything that doesn't fit the UI before locking further

---

## 1. Conventions used throughout

- Base path: `/api/v1`
- Auth: Firebase ID token in `Authorization: Bearer <token>`, verified server-side; role (`admin`/`outlet_manager`) and `outlet_id` resolved from the `users` table, never trusted from the request body.
- All money fields are strings representing `NUMERIC(12,2)` (e.g. `"145.00"`), never JS floats — avoids precision loss in transit.
- Every offline-eligible write (sales, stock movements, expenses) requires `client_id` in the body. Every response for those includes `"idempotent_replay": true|false` so the client can tell whether this was a fresh insert or a safe re-send.

### `GET /api/v1/me`
Returns the authenticated caller's identity, resolved server-side from the `users` table (never trusted from the request).

**Response `200`:**
```json
{
  "id": "uuid",
  "role": "outlet_manager",
  "outlet_id": "uuid",
  "display_name": "Ama Mensah"
}
```
`outlet_id` is `null` for admins and for any `outlet_manager` not yet assigned to an outlet. `display_name` is nullable — not every user has one set (`users.display_name` has no `NOT NULL`, see design doc §2.2).

- Standard error envelope:
```json
{
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Product no longer exists in this outlet's catalog.",
    "retryable": false
  }
}
```
`retryable: true` tells the client this is worth re-queuing (e.g. transient DB issue); `false` means it needs human resolution (Kojo's "please resolve" UI state) — this maps directly to §3.4 of the design doc.

**Settled error codes** (all `retryable: false`):

| Code | HTTP status |
|---|---|
| `PRODUCT_NOT_FOUND` | 404 |
| `OUTLET_NOT_FOUND` | 404 |
| `INSUFFICIENT_STOCK` | 409 |
| `VALIDATION_ERROR` | 422 |
| `UNAUTHENTICATED` | 401 |
| `USER_NOT_PROVISIONED` | 403 |
| `USER_DISABLED` | 403 |

**`outlet_id` resolution rule**, enforced on every endpoint that takes an `outlet_id`: for an `outlet_manager`, the `outlet_id` from their own auth context (`users.outlet_id`) always wins — any `outlet_id` supplied in the request body or query string is ignored. For an `admin`, `outlet_id` must be supplied, and the admin must own that outlet (`outlets.admin_id`) — otherwise the response is `404 OUTLET_NOT_FOUND`, identical to the response for an outlet that doesn't exist at all, so the caller can never distinguish "not yours" from "doesn't exist."

---

## 2. Sales (offline-eligible)

### `POST /api/v1/sales`
**Request:**
```json
{
  "client_id": "outlet-7f3a-1234-9c21",
  "outlet_id": "uuid",
  "line_items": [
    { "product_id": "uuid", "quantity": 2, "submitted_unit_price": "15.00" }
  ],
  "payment_method": "mobile_money",
  "discount_type": "percentage",
  "discount_value": "10.00",
  "tax_amount": "3.00",
  "device_recorded_at": "2026-08-31T18:42:03Z"
}
```
`discount_value` is a `NUMERIC(12,2)`-shaped string whose *meaning* depends on `discount_type`: `0.00`–`100.00` when `discount_type` is `"percentage"` (this is **not** a money amount — the decimal type is reused for precision only), or a GHS money amount when `discount_type` is `"fixed"`.

**Response `201`:**
```json
{
  "id": "uuid",
  "client_id": "outlet-7f3a-1234-9c21",
  "status": "completed",
  "subtotal_amount": "30.00",
  "discount_amount": "3.00",
  "tax_amount": "3.00",
  "total_amount": "30.00",
  "price_variance_flagged": false,
  "created_at": "2026-08-31T19:05:11Z",
  "idempotent_replay": false
}
```
> Server-side pricing authority: `submitted_unit_price` per line is persisted verbatim as `sale_line_items.unit_price` — it is never silently replaced by a live catalog lookup. The server independently computes `subtotal_amount`, `discount_amount`, and `total_amount` from persisted line items and `discount_type`/`discount_value`; none of these three are ever accepted from the client. See `ultimate-bookkeeping-v2-design.md` §3.7 for the full price-variance rule and default tolerance.

**Errors:** `PRODUCT_NOT_FOUND` (retryable: false), `INSUFFICIENT_STOCK` (retryable: false — surfaced to cashier, not silently retried), `VALIDATION_ERROR` (retryable: false).

### `POST /api/v1/sales/{id}/void`
Admin/outlet_manager with permission only. Not offline-eligible — voids happen online, deliberately, with a reason.
```json
{ "reason": "customer return" }
```

### `GET /api/v1/sales?outlet_id=&from=&to=&price_variance_flagged=`
Paginated, `created_at`-ordered (never `device_recorded_at` — per design doc §3.5).

---

## 3. Stock (offline-eligible for adjustments/restocks; sale-driven movements are internal)

### `POST /api/v1/stock/adjustments`
```json
{
  "client_id": "outlet-9a12-...",
  "product_id": "uuid",
  "outlet_id": "uuid",
  "delta": -3,
  "reason": "adjustment"
}
```
**Response `201`:** same idempotent-replay shape as sales, plus the resulting `stock_levels.quantity`.

### `GET /api/v1/stock/levels?outlet_id=`
Reads from the `stock_levels` cache table, not a live aggregate — fast, matches Ama's "post-action freshness ≤2s" KPI.

---

## 4. Expenses (offline-eligible)

### `POST /api/v1/expenses`
```json
{
  "client_id": "outlet-...",
  "outlet_id": "uuid",
  "amount": "50.00",
  "category": "utilities",
  "note": "generator fuel",
  "device_recorded_at": "..."
}
```
Same idempotent-replay/error pattern as sales.

---

## 5. Liabilities & Settlements (online-only — per Ama's offline scope call)

### `POST /api/v1/liabilities`
Admin-only. Records a liability (e.g. supplier owed). No `client_id`/offline path — deliberate, since these are lower-frequency, admin-console actions.

### `POST /api/v1/liabilities/{id}/payments`
Records a payment against a liability. Runs inside a Postgres transaction that updates the liability's outstanding balance — never a client-side balance calculation.

### `POST /api/v1/settlements`
Admin-only. Computes and records an outlet settlement over a period. This is the endpoint Ama's "settlement reliability ≥99%, mismatch ≤1%" KPI lives or dies on — Adjoa should build the heaviest test coverage here.

---

## 6. Reports (online-only, read-heavy)

### `GET /api/v1/reports/financial?outlet_id=&period=`
Returns aggregated totals computed server-side from `sales`/`expenses`/`liabilities` — never recomputed client-side, so Dashboard/Accounting/Reports/Exports can't disagree (directly serves the "data trust parity ≥99%" KPI).

---

## 7. What Kojo needs to build against first

Priority order for the Outlet app: `POST /sales`, `GET /stock/levels`, `POST /stock/adjustments`, `POST /expenses` — that's the full offline-eligible surface and covers the outlet manager's entire daily workflow. Admin-console endpoints (liabilities, settlements, reports) can come after the Outlet app's core loop is working end to end.

---

## 8. Parallel-track notes (non-blocking)

- **Yaw:** cost/ops comparison for Supabase vs. Neon vs. Cloud SQL still open — doesn't block Efua or Kojo starting, but needs to land before deployment planning.
- **Nana:** row-level security policy sketch for Supabase — should target the same role boundaries already proven out in the existing `firestore.rules` (`isOwner`, `isOutletManagerFor`, `isManagerForOutlet`) rather than reinventing them from scratch.
