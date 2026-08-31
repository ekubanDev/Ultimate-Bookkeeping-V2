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

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    unit_price: str

    _validate_unit_price = field_validator("unit_price")(validate_money_string)

    @property
    def unit_price_decimal(self) -> Decimal:
        return Decimal(self.unit_price)


class SaleCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    client_id: str = Field(min_length=1)
    outlet_id: uuid.UUID
    line_items: list[SaleLineItemIn] = Field(min_length=1)
    payment_method: str | None = None
    discount_amount: str = "0.00"
    tax_amount: str = "0.00"
    device_recorded_at: datetime | None = None

    _validate_discount = field_validator("discount_amount")(validate_money_string)
    _validate_tax = field_validator("tax_amount")(validate_money_string)

    @property
    def discount_amount_decimal(self) -> Decimal:
        return Decimal(self.discount_amount)

    @property
    def tax_amount_decimal(self) -> Decimal:
        return Decimal(self.tax_amount)


class SaleResponse(BaseModel):
    id: uuid.UUID
    client_id: str
    status: str
    total_amount: str
    created_at: datetime
    idempotent_replay: bool

    model_config = ConfigDict(from_attributes=True)


class ErrorDetail(BaseModel):
    code: str
    message: str
    retryable: bool


class ErrorEnvelope(BaseModel):
    error: ErrorDetail
