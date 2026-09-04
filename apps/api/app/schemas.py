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

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

_MONEY_RE = re.compile(r"^\d+(\.\d{1,2})?$")


def validate_money_string(value: str) -> str:
    """Validate a wire-format money string: non-negative, <=2dp, no floats.

    Pydantic v2 does not implicitly coerce int/float to str in lax mode, so a
    JSON number like `15.0` (as opposed to the string `"15.00"`) is already
    rejected by the field's `str` type before this validator even runs — this
    function additionally guards against strings with the wrong shape, e.g.
    `"15.000"` (3dp), `"-1.00"` (negative), `"abc"`, `""`.
    """
    if not isinstance(value, str) or not _MONEY_RE.match(value):
        raise ValueError(
            "must be a non-negative decimal string with at most 2 decimal places, e.g. '15.00'"
        )
    return value


class SaleLineItemIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    product_id: uuid.UUID
    quantity: int = Field(gt=0)
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
    line_items: list[SaleLineItemIn] = Field(min_length=1)
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
