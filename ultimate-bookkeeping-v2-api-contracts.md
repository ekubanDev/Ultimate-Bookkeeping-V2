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

**Rate limiting** (`apps/api/app/rate_limit.py`): every endpoint is rate-limited, keyed by the authenticated user (`users.id`, once request auth has resolved one) and falling back to client IP for requests that never get that far (bad/missing/expired token — still a meaningful bound on anonymous floods, including credential-probing). This matters specifically for shared-connection outlet setups: several cashier devices at one outlet often sit behind a single NAT IP, so keying by user rather than IP alone keeps one busy till from starving the others.

Exceeding the limit returns `429` with the standard error envelope:
```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Please retry shortly.",
    "retryable": true
  }
}
```
`retryable: true` is the load-bearing detail, not a formality — the offline queue (`packages/offline-queue`) branches on this field. A throttled offline-eligible write (sale, stock adjustment, expense) is re-queued and retried with capped backoff, exactly like a transient network failure; it is never surfaced to the cashier as a failed sale (see design doc §3.4, §3.8-§3.11).

Current limits (named constants in `apps/api/app/rate_limit.py`, tunable — Yaw owns these):

| Constant | Value | Applies to |
|---|---|---|
| `WRITE_RATE_LIMIT` | 30/minute | `POST /sales`, `POST /stock/adjustments`, `POST /expenses` |
| `READ_RATE_LIMIT` | 120/minute | `GET /sales`, `GET /stock/levels`, `GET /products` |
| `AUTH_RATE_LIMIT` | 20/minute | `GET /me` |

Caveat (from the module docstring): the limiter uses `slowapi`'s in-process memory backend — there's no Redis/shared-cache tier today. Counters are **not** shared across worker processes, so in a multi-worker deployment the effective ceiling is the per-worker limit × worker count, not a single global cap. Revisit if/when this becomes a multi-process deployment.

---

## 2. Products (online-only, read)

### `GET /api/v1/products?outlet_id=&limit=&offset=`
Read-only catalog listing — replaces the outlet app's previously-hardcoded demo catalog. Not offline-eligible (no `client_id`, no queue).

Tenant-scoped via the same `outlet_id` resolution rule as §1 (`resolve_authorized_outlet`): an `outlet_manager`'s own outlet always wins; an `admin` must own the requested outlet; a nonexistent outlet and one belonging to another tenant both return the identical `404 OUTLET_NOT_FOUND`. Catalog rows are further scoped by `products.admin_id == outlet.admin_id`.

Ordered by `name`. `limit` default `50`, max `200`; `offset` default `0` — same pagination convention as `GET /sales` and `GET /stock/levels`.

**Response `200`:**
```json
[
  { "id": "uuid", "sku": "SKU-001", "name": "Milo 400g", "unit_price": "15.00", "min_stock": 10 }
]
```
`sku` and `min_stock` are nullable — `products.sku` and `products.min_stock` have no `NOT NULL` (design doc §2.3), same precedent as `MeResponse.display_name` above: modeled as nullable to match the real data rather than silently coercing a `NULL` catalog row into `0`/`""`.

Rate-limited under `READ_RATE_LIMIT` (§1).

---

## 3. Sales (offline-eligible)

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

### `GET /api/v1/sales?outlet_id=&from=&to=&price_variance_flagged=&limit=&offset=`
Paginated, `created_at`-ordered — **ascending** (oldest first), never `device_recorded_at` — per design doc §3.5.

Query params:
- `outlet_id` — same resolution rule as §1 (ignored for `outlet_manager`, required and ownership-checked for `admin`).
- `from` / `to` — optional ISO 8601 timestamps, inclusive bounds on `created_at`. (`from` is the query param name; it's an aliased field server-side since `from` is a reserved word.)
- `price_variance_flagged` — optional boolean filter. When present, filters to sales where *any* line item's `price_variance_flagged` matches the requested value (OR across the sale's line items — same aggregation `POST /sales`'s response uses).
- `limit` — default `50`, max `200`. `offset` — default `0`. Same convention as `GET /products`.

**Response `200`:** list of `SaleListItemResponse` — mirrors the `POST /sales` response shape minus `idempotent_replay` (meaningless outside a single-write response), plus `outlet_id` and `payment_method`:
```json
[
  {
    "id": "uuid",
    "client_id": "outlet-7f3a-1234-9c21",
    "outlet_id": "uuid",
    "status": "completed",
    "payment_method": "mobile_money",
    "subtotal_amount": "30.00",
    "discount_amount": "3.00",
    "tax_amount": "3.00",
    "total_amount": "30.00",
    "price_variance_flagged": false,
    "created_at": "2026-08-31T19:05:11Z"
  }
]
```
`payment_method` is nullable (matches `POST /sales`'s optional request field).

Rate-limited under `READ_RATE_LIMIT` (§1).

---

## 4. Stock (offline-eligible for adjustments/restocks; sale-driven movements are internal)

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
Reads from the `stock_levels` cache table, not a live aggregate — fast, matches Ama's "post-action freshness ≤2s" KPI. Ordered by product name; joins `products` for display fields, scoped the same way as `GET /products` (§2).

**Response `200`:**
```json
[
  {
    "product_id": "uuid",
    "product_name": "Milo 400g",
    "sku": "SKU-001",
    "quantity": 42,
    "min_stock": 10,
    "updated_at": "2026-08-31T19:05:11Z"
  }
]
```
`sku` and `min_stock` are nullable, same precedent as `GET /products` (§2) — sourced from the same `products` row. `min_stock` is what powers the outlet app's low-stock visual cue.

Rate-limited under `READ_RATE_LIMIT` (§1).

---

## 5. Expenses (offline-eligible)

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

## 6. Liabilities & Settlements (online-only — per Ama's offline scope call)

### `POST /api/v1/liabilities`
Admin-only. Records a liability (e.g. supplier owed). No `client_id`/offline path — deliberate, since these are lower-frequency, admin-console actions.

### `POST /api/v1/liabilities/{id}/payments`
Records a payment against a liability. Runs inside a Postgres transaction that updates the liability's outstanding balance — never a client-side balance calculation.

### `POST /api/v1/settlements`
Admin-only. Computes and records an outlet settlement over a period. This is the endpoint Ama's "settlement reliability ≥99%, mismatch ≤1%" KPI lives or dies on — Adjoa should build the heaviest test coverage here.

---

## 7. Reports (online-only, read-heavy)

### `GET /api/v1/reports/financial?outlet_id=&period=`
Returns aggregated totals computed server-side from `sales`/`expenses`/`liabilities` — never recomputed client-side, so Dashboard/Accounting/Reports/Exports can't disagree (directly serves the "data trust parity ≥99%" KPI).

---

## 8. What Kojo needs to build against first

Priority order for the Outlet app: `POST /sales`, `GET /stock/levels`, `POST /stock/adjustments`, `POST /expenses` — that's the full offline-eligible surface and covers the outlet manager's entire daily workflow. Admin-console endpoints (liabilities, settlements, reports) can come after the Outlet app's core loop is working end to end.

---

## 9. Parallel-track notes (non-blocking)

- **Yaw:** cost/ops comparison for Supabase vs. Neon vs. Cloud SQL still open — doesn't block Efua or Kojo starting, but needs to land before deployment planning.
- **Nana:** row-level security policy sketch for Supabase — should target the same role boundaries already proven out in the existing `firestore.rules` (`isOwner`, `isOutletManagerFor`, `isManagerForOutlet`) rather than reinventing them from scratch.
