"""Pydantic request/response models.

Money fields travel over the wire as strings (never floats/JS numbers) per
api-contracts.md §1 — "avoids precision loss in transit". We validate them as
non-negative decimals with at most 2 decimal places, matching NUMERIC(12,2).
Internally we always convert to `decimal.Decimal`; we never touch `float` for
money math.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

from app.pricing import compute_line_total

_MONEY_RE = re.compile(r"^\d+(\.\d{1,2})?$")

# NUMERIC(12,2) ceiling (alembic/versions/6cca266108dc_initial_schema.py):
# 12 significant digits total, 2 of them after the decimal point, so at most
# 10 integer digits -> max value 9,999,999,999.99. Every money column in the
# schema (products.unit_price, sale_line_items.unit_price/line_total,
# sales.subtotal_amount/discount_value/discount_amount/tax_amount/
# total_amount, expenses.amount) is NUMERIC(12,2), so this single constant is
# the ceiling for all of them.
MONEY_MAX_VALUE = Decimal("9999999999.99")

# Upper bounds on a sale's shape (Adjoa's QA finding): `sale_line_items.quantity`
# and `SaleCreateRequest.line_items` had no ceiling at all, so a large
# `quantity` x `unit_price` could exceed what a `NUMERIC(12,2)` column can
# hold (~10 integer digits, max 9,999,999,999.99 — see
# alembic/versions/6cca266108dc_initial_schema.py), and a pathologically long
# line-item list was accepted unbounded (a DoS/cost vector: each line item
# does a catalog lookup, a stock check, and inserts a SaleLineItem +
# StockMovement row inside one transaction).
#
# Bounds are grounded in Ghanaian retail-outlet reality, not just arithmetic
# headroom:
# - MAX_QUANTITY_PER_LINE_ITEM = 10,000: even a large bulk/wholesale-style
#   purchase of a single SKU at one outlet (e.g. sachet water for an event,
#   a bulk cement order) realistically tops out in the hundreds to low
#   thousands; 10,000 leaves generous headroom above that while making a
#   fat-fingered or probing extreme value impossible. Paired with a
#   plausible catalog price ceiling (well under NUMERIC(12,2)'s ~10-digit
#   capacity), this keeps ordinary sales nowhere near the DB boundary.
# - MAX_LINE_ITEMS_PER_SALE = 100: a single checkout basket in this market
#   rarely exceeds a few dozen distinct SKUs; 100 comfortably covers even an
#   unusually large basket while bounding both the sum-of-line-totals
#   overflow risk and the per-request DB/processing cost — the latter
#   matters doubly here since offline-queued sales sync over often-slow,
#   metered West African mobile connections, where an unbounded payload is
#   also a client-side cost/battery concern.
#
# CLOSED (previously flagged as out of scope here): `submitted_unit_price`
# (and every other field sharing `validate_money_string`) now carries its own
# digit-count ceiling — `MONEY_MAX_VALUE`, above — so quantity/line-count
# bounds no longer have to (and can't, on their own — see the arithmetic on
# `_validate_sale_totals_within_numeric_ceiling` below) carry the entire
# overflow-prevention burden. MAX_QUANTITY_PER_LINE_ITEM alone is NOT a
# sufficient guard even with a bounded unit_price: 10,000 (quantity) x
# 9,999,999,999.99 (a single, individually-valid, post-fix unit_price) is
# ~9.9999999999999e13 — twelve orders of magnitude past what a single
# `sale_line_items.line_total NUMERIC(12,2)` can hold, from ONE line item,
# before summing across the basket even starts. The aggregate guard on
# `SaleCreateRequest` below is what actually closes that.
MAX_QUANTITY_PER_LINE_ITEM = 10_000
MAX_LINE_ITEMS_PER_SALE = 100


def validate_money_string(value: str) -> str:
    """Validate a wire-format money string: non-negative, <=2dp, no floats.

    Pydantic v2 does not implicitly coerce int/float to str in lax mode, so a
    JSON number like `15.0` (as opposed to the string `"15.00"`) is already
    rejected by the field's `str` type before this validator even runs — this
    function additionally guards against strings with the wrong shape, e.g.
    `"15.000"` (3dp), `"-1.00"` (negative), `"abc"`, `""`.

    Also enforces `MONEY_MAX_VALUE`, the NUMERIC(12,2) digit-count ceiling —
    without this, a value like `"99999999999999.99"` passes the shape regex
    (it IS a non-negative, <=2dp decimal string) but can never be persisted:
    on Postgres it's a 500 (`numeric field overflow`) raised well past this
    validation boundary, after other side effects (stock checks, etc.) may
    already have run; on SQLite (no NUMERIC precision enforcement) it would
    silently "succeed" while storing a value the production database could
    never actually hold. Rejecting it here, at the API boundary, makes the
    behavior identical — a clean `VALIDATION_ERROR` (422) — on both.

    Applies uniformly across every reading of every field that shares this
    validator: `SaleLineItemIn.submitted_unit_price`,
    `SaleCreateRequest.tax_amount`, `SaleCreateRequest.discount_value` (both
    as a 'fixed' GHS amount AND as a 'percentage' 0-100 value — 100.00 is far
    below `MONEY_MAX_VALUE`, so this bound never interferes with the
    tighter, percentage-specific 0-100 check layered on top of it), and
    `ExpenseCreateRequest.amount`.
    """
    if not isinstance(value, str) or not _MONEY_RE.match(value):
        raise ValueError(
            "must be a non-negative decimal string with at most 2 decimal places, e.g. '15.00'"
        )
    if Decimal(value) > MONEY_MAX_VALUE:
        raise ValueError(f"must not exceed {MONEY_MAX_VALUE} (NUMERIC(12,2) ceiling)")
    return value


class SaleLineItemIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    product_id: uuid.UUID
    quantity: int = Field(gt=0, le=MAX_QUANTITY_PER_LINE_ITEM)
    # Renamed from `unit_price` (deliberate — server-authoritative pricing
    # spec, Ama/Nana): the old name invited treating client input as
    # authoritative. This is the cashier-entered price; the server persists
    # it verbatim as `sale_line_items.unit_price` but computes totals from
    # it after cross-checking against the catalog (app/pricing.py).
    submitted_unit_price: str

    _validate_submitted_unit_price = field_validator("submitted_unit_price")(validate_money_string)

    @property
    def submitted_unit_price_decimal(self) -> Decimal:
        return Decimal(self.submitted_unit_price)


class SaleCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    client_id: str = Field(min_length=1)
    outlet_id: uuid.UUID
    line_items: list[SaleLineItemIn] = Field(min_length=1, max_length=MAX_LINE_ITEMS_PER_SALE)
    payment_method: str | None = None
    # Raw cashier input — server computes `discount_amount` from these, it
    # is never accepted directly (app/pricing.py `compute_discount_amount`).
    # `discount_value` means different things depending on `discount_type`:
    # 0.00-100.00 (NOT money) for 'percentage', a GHS amount for 'fixed'.
    discount_type: Literal["percentage", "fixed"] = "fixed"
    discount_value: str = "0.00"
    tax_amount: str = "0.00"
    device_recorded_at: datetime | None = None

    _validate_tax = field_validator("tax_amount")(validate_money_string)

    @field_validator("discount_value")
    @classmethod
    def _validate_discount_value(cls, value: str, info: ValidationInfo) -> str:
        validate_money_string(value)
        discount_type = info.data.get("discount_type")
        if discount_type == "percentage" and Decimal(value) > Decimal("100.00"):
            raise ValueError(
                "discount_value must be between 0.00 and 100.00 when discount_type is 'percentage'"
            )
        return value

    @property
    def discount_value_decimal(self) -> Decimal:
        return Decimal(self.discount_value)

    @property
    def tax_amount_decimal(self) -> Decimal:
        return Decimal(self.tax_amount)

    @model_validator(mode="after")
    def _validate_sale_totals_within_numeric_ceiling(self) -> "SaleCreateRequest":
        """Aggregate overflow guard — closes the gap per-field bounds can't
        reach on their own.

        Every per-field money bound (`MONEY_MAX_VALUE` in `validate_money_string`)
        constrains one string in isolation. It cannot constrain a *product*
        like `quantity * submitted_unit_price`, and both
        `sale_line_items.line_total` and `sales.subtotal_amount` are
        themselves NUMERIC(12,2) columns holding exactly that kind of
        product/sum. Concretely, with `MAX_QUANTITY_PER_LINE_ITEM = 10_000`:

            10_000 * Decimal("9999999999.99") = 99_999_999_999_900.00

        — a single line item, each of whose inputs individually satisfies
        its own per-field bound, produces a `line_total` ~1e13 over what
        `NUMERIC(12,2)` can store. So the per-field bound plus the existing
        quantity/line-count bounds do NOT make overflow unreachable; this
        model-level check is required, not optional hardening.

        We check the *summed* `subtotal_amount` (sum of every line's
        `quantity * submitted_unit_price`) against `MONEY_MAX_VALUE` rather
        than each line separately: every `line_total` is non-negative, so
        each one is individually <= the sum. One check on the sum therefore
        also bounds every individual `line_total` — this is exactly the
        "100 line items x 10,000 quantity x a large unit_price" aggregate
        case flagged in the task, and it subsumes the single-line-item case
        above (a 1-line sale's subtotal IS that line's line_total).

        `total_amount` (`subtotal_amount - discount_amount + tax_amount`,
        also NUMERIC(12,2)) is the other computed column that could still
        overflow even with a bounded subtotal, if `tax_amount` is itself
        near `MONEY_MAX_VALUE` too. We don't need to reimplement
        `compute_discount_amount` here to bound it: `discount_amount` is
        always clamped into `[0, subtotal_amount]` by construction
        (app/pricing.py — 'fixed' is `min(discount_value, subtotal_amount)`;
        'percentage' is `subtotal_amount * pct / 100` with `pct` already
        checked <= 100.00 by `_validate_discount_value` above). So
        `total_amount <= subtotal_amount - 0 + tax_amount`, i.e.
        `subtotal_amount + tax_amount` is always an upper bound on
        `total_amount` regardless of discount. Checking that sum is
        therefore sufficient without duplicating the discount math (and
        without drifting from it if that math ever changes).
        """
        subtotal_amount = sum(
            (
                compute_line_total(item.quantity, item.submitted_unit_price_decimal)
                for item in self.line_items
            ),
            Decimal("0.00"),
        )
        if subtotal_amount > MONEY_MAX_VALUE:
            raise ValueError(
                "sum of line items (quantity x submitted_unit_price) exceeds the maximum a "
                f"sale can hold ({MONEY_MAX_VALUE})"
            )
        if subtotal_amount + self.tax_amount_decimal > MONEY_MAX_VALUE:
            raise ValueError(
                "subtotal_amount + tax_amount exceeds the maximum total_amount can hold "
                f"({MONEY_MAX_VALUE})"
            )
        return self


class SaleResponse(BaseModel):
    id: uuid.UUID
    client_id: str
    status: str
    # subtotal_amount, discount_amount, total_amount are always
    # server-computed/recomputed (app/pricing.py) and returned here — never
    # accepted from the client body, regardless of what the request sent.
    subtotal_amount: str
    discount_amount: str
    tax_amount: str
    total_amount: str
    # OR across line-level `price_variance_flagged` — flag only, never a
    # rejection reason (no new error code exists for a variance).
    price_variance_flagged: bool
    created_at: datetime
    idempotent_replay: bool

    model_config = ConfigDict(from_attributes=True)


class SaleListItemResponse(BaseModel):
    """GET /api/v1/sales list item.

    Resolved ambiguity: api-contracts.md §2 documents `GET /api/v1/sales`
    (paginated, `created_at`-ordered) but no response shape had been
    implemented yet in this codebase before this change, and Kwame/Ama own
    that doc (not edited here). This mirrors `SaleResponse` minus
    `idempotent_replay` (meaningless outside a single-write response) — flag
    for Ama/Kwame to confirm/lock in api-contracts.md.
    """

    id: uuid.UUID
    client_id: str
    outlet_id: uuid.UUID
    status: str
    payment_method: str | None
    subtotal_amount: str
    discount_amount: str
    tax_amount: str
    total_amount: str
    price_variance_flagged: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class StockAdjustmentRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    client_id: str = Field(min_length=1)
    product_id: uuid.UUID
    outlet_id: uuid.UUID
    # `reason` is restricted to the two offline-eligible reasons this endpoint
    # accepts (api-contracts.md §3 header: "offline-eligible for
    # adjustments/restocks"). 'sale' is written exclusively by the sales
    # endpoint; 'transfer' isn't part of this MVP surface.
    reason: Literal["restock", "adjustment"]
    delta: int

    @field_validator("delta")
    @classmethod
    def _validate_delta_nonzero(cls, value: int) -> int:
        if value == 0:
            raise ValueError("delta must be a non-zero integer")
        return value


class StockAdjustmentResponse(BaseModel):
    id: uuid.UUID
    client_id: str
    # Mirrors the sales response envelope shape (id, client_id, status,
    # created_at, idempotent_replay) for uniform client-side offline-queue
    # handling, plus `quantity` — the resulting stock_levels.quantity per
    # api-contracts.md §3. stock_movements rows have no natural "status" of
    # their own; "recorded" is used as the fixed value so the envelope shape
    # stays consistent across all offline-eligible endpoints.
    status: str
    quantity: int
    created_at: datetime
    idempotent_replay: bool

    model_config = ConfigDict(from_attributes=True)


class StockLevelResponse(BaseModel):
    product_id: uuid.UUID
    product_name: str
    sku: str | None
    quantity: int
    # Added alongside GET /api/v1/products (task spec) so the outlet app's
    # StockLevelList can render a low-stock visual cue — previously absent,
    # which is why Kojo had shipped that cue as a TODO. Sourced from the
    # same `products` join `GET /levels` already performs (products.min_stock
    # — nullable in the schema, see app/models.py Product). Needs a line in
    # api-contracts.md §3 (Kwame/Ama's doc, not edited here).
    min_stock: int | None
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProductResponse(BaseModel):
    """GET /api/v1/products — frozen contract (task spec); Kojo builds
    against this exact shape. Not yet in api-contracts.md — flagged for
    Kwame/Ama to add (not edited here, per convention established by
    app/routers/me.py for the other undocumented-but-frozen endpoint).

    NOTE (same caveat pattern as `MeResponse.display_name`): the task's
    literal example response shows `min_stock` as a plain int and `sku`
    always present, but both are nullable in the `products` table
    (app/models.py — `sku: Text | None`, `min_stock: Integer | None`).
    Modeled here as `| None` to match the real data instead of silently
    coercing a NULL catalog row into `0`/`""`; flag for Kwame/Ama alongside
    the doc addition.
    """

    id: uuid.UUID
    sku: str | None
    name: str
    unit_price: str
    min_stock: int | None

    model_config = ConfigDict(from_attributes=True)


class ExpenseCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    client_id: str = Field(min_length=1)
    outlet_id: uuid.UUID
    amount: str
    category: str = Field(min_length=1)
    note: str | None = None
    device_recorded_at: datetime | None = None

    _validate_amount = field_validator("amount")(validate_money_string)

    @property
    def amount_decimal(self) -> Decimal:
        return Decimal(self.amount)


class ExpenseResponse(BaseModel):
    id: uuid.UUID
    client_id: str
    status: str
    amount: str
    created_at: datetime
    idempotent_replay: bool

    model_config = ConfigDict(from_attributes=True)


class MeResponse(BaseModel):
    """GET /api/v1/me — frozen shape, Kojo builds against this exactly (see
    app/routers/me.py). NOTE: `display_name` is nullable in the `users` table
    (design.md §2.2 has no NOT NULL on it) even though it isn't marked
    nullable in the task's literal response shape; modeled here as
    `str | None` to match the real data rather than silently coercing NULL to
    `""`. Flagged for Kwame/Ama when this endpoint is added to
    api-contracts.md.
    """

    id: uuid.UUID
    role: str
    outlet_id: uuid.UUID | None
    display_name: str | None

    model_config = ConfigDict(from_attributes=True)


class ErrorDetail(BaseModel):
    code: str
    message: str
    retryable: bool


class ErrorEnvelope(BaseModel):
    error: ErrorDetail
