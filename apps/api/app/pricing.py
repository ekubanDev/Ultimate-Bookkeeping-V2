"""Pure money-computation functions for POST /api/v1/sales.

Server-authoritative pricing (Ama's finalized spec, prompted by Nana's
skimming finding): `total_amount` must never be derived purely from
client-supplied numbers. This module contains ONLY the arithmetic — no DB
session, no ORM objects, no request/response models — so it's unit-testable
without a database, per the FP guide (tesseract-fp-guide.md §3: "Keep the
Postgres transaction boundary as the one place side effects happen —
everything that computes what should be written stays pure").

Callers (routers/sales.py) are responsible for:
- resolving `catalog_unit_price` per line from the `products` table at
  transaction-commit time,
- persisting the computed values,
- everything else that touches the database.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable, Literal

TWO_PLACES = Decimal("0.01")
ZERO = Decimal("0.00")

DiscountType = Literal["percentage", "fixed"]


@dataclass(frozen=True)
class LineItemInput:
    """One sale line item as far as the pricing engine cares.

    `unit_price` is the price actually charged (server never overwrites it
    with a catalog lookup — a completed, paid transaction isn't repriced
    after the fact). `catalog_unit_price` is `products.unit_price` read at
    commit time, audit-only, never used in the money math below.
    """

    quantity: int
    unit_price: Decimal
    catalog_unit_price: Decimal


@dataclass(frozen=True)
class LineItemComputed:
    unit_price: Decimal
    catalog_unit_price_at_sale: Decimal
    line_total: Decimal
    price_variance_flagged: bool


@dataclass(frozen=True)
class SaleTotals:
    line_items: tuple[LineItemComputed, ...]
    subtotal_amount: Decimal
    discount_amount: Decimal
    tax_amount: Decimal
    total_amount: Decimal
    price_variance_flagged: bool


def compute_line_total(quantity: int, unit_price: Decimal) -> Decimal:
    """`quantity * unit_price`, exact — integer qty times 2dp money needs no
    rounding (Decimal multiplication is exact for these operand scales)."""
    return quantity * unit_price


def is_price_variance_flagged(unit_price: Decimal, catalog_unit_price: Decimal) -> bool:
    """Flag-only signal, never blocking: `|unit_price - catalog| > tolerance`,
    where tolerance is the greater of 2% of catalog price or a flat GHS 0.50
    floor (protects cheap items, where 2% is pesewas, from false positives
    on ordinary rounding/negotiation)."""
    tolerance = max(catalog_unit_price * Decimal("0.02"), Decimal("0.50"))
    return abs(unit_price - catalog_unit_price) > tolerance


def compute_discount_amount(
    *, discount_type: DiscountType, discount_value: Decimal, subtotal_amount: Decimal
) -> Decimal:
    """- 'fixed': raw GHS amount, clamped so a discount can never exceed the
      subtotal (`min(discount_value, subtotal_amount)`).
    - 'percentage': `subtotal_amount * discount_value / 100`, computed at
      full Decimal precision and rounded ROUND_HALF_UP to 2dp exactly once
      here — never per-line, never twice. Callers are responsible for
      rejecting an out-of-range (0.00-100.00) percentage before calling this
      (that's a request-shape validation concern, not a pricing-math one).
    """
    if discount_type == "fixed":
        return min(discount_value, subtotal_amount)
    if discount_type == "percentage":
        raw = subtotal_amount * discount_value / Decimal("100")
        return raw.quantize(TWO_PLACES, rounding=ROUND_HALF_UP)
    raise ValueError(f"unknown discount_type: {discount_type!r}")


def compute_sale_totals(
    line_items: Iterable[LineItemInput],
    *,
    discount_type: DiscountType,
    discount_value: Decimal,
    tax_amount: Decimal,
) -> SaleTotals:
    """The whole server-authoritative pricing computation, pure.

    tax_amount is trusted verbatim (tax is explicitly out of scope for this
    change) — it only participates in the final `total_amount` sum.
    """
    computed_lines = tuple(
        LineItemComputed(
            unit_price=item.unit_price,
            catalog_unit_price_at_sale=item.catalog_unit_price,
            line_total=compute_line_total(item.quantity, item.unit_price),
            price_variance_flagged=is_price_variance_flagged(item.unit_price, item.catalog_unit_price),
        )
        for item in line_items
    )

    subtotal_amount = sum((line.line_total for line in computed_lines), ZERO)
    discount_amount = compute_discount_amount(
        discount_type=discount_type, discount_value=discount_value, subtotal_amount=subtotal_amount
    )
    total_amount = subtotal_amount - discount_amount + tax_amount
    if total_amount < ZERO:
        total_amount = ZERO

    return SaleTotals(
        line_items=computed_lines,
        subtotal_amount=subtotal_amount,
        discount_amount=discount_amount,
        tax_amount=tax_amount,
        total_amount=total_amount,
        price_variance_flagged=any(line.price_variance_flagged for line in computed_lines),
    )
