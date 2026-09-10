"""Unit tests for the pure money-computation functions in app/pricing.py —
no database, no FastAPI, no async — per tesseract-fp-guide.md §3."""
from __future__ import annotations

from decimal import Decimal

from app.pricing import (
    LineItemInput,
    compute_discount_amount,
    compute_line_total,
    compute_sale_totals,
    is_price_variance_flagged,
)


def test_compute_line_total_exact_no_rounding():
    assert compute_line_total(3, Decimal("10.05")) == Decimal("30.15")


def test_fixed_discount_clamped_to_subtotal():
    assert compute_discount_amount(
        discount_type="fixed", discount_value=Decimal("999.00"), subtotal_amount=Decimal("15.00")
    ) == Decimal("15.00")


def test_fixed_discount_under_subtotal_passes_through():
    assert compute_discount_amount(
        discount_type="fixed", discount_value=Decimal("5.00"), subtotal_amount=Decimal("15.00")
    ) == Decimal("5.00")


def test_percentage_discount_rounds_half_up_on_exact_boundary():
    # 50.00 * 0.25% = 0.125 -- digit before the terminal 5 is '2' (even),
    # so ROUND_HALF_EVEN would give 0.12; ROUND_HALF_UP (spec) gives 0.13.
    assert compute_discount_amount(
        discount_type="percentage", discount_value=Decimal("0.25"), subtotal_amount=Decimal("50.00")
    ) == Decimal("0.13")


def test_percentage_discount_rounded_once_on_combined_subtotal():
    combined = compute_discount_amount(
        discount_type="percentage", discount_value=Decimal("10.00"), subtotal_amount=Decimal("20.10")
    )
    per_line_summed = sum(
        (
            compute_discount_amount(
                discount_type="percentage", discount_value=Decimal("10.00"), subtotal_amount=Decimal("10.05")
            )
            for _ in range(2)
        ),
        Decimal("0.00"),
    )
    assert combined == Decimal("2.01")
    assert per_line_summed == Decimal("2.02")
    assert combined != per_line_summed


def test_is_price_variance_flagged_cheap_item_flat_floor_not_flagged():
    assert is_price_variance_flagged(Decimal("3.06"), Decimal("3.00")) is False


def test_is_price_variance_flagged_expensive_item_two_percent_flagged():
    assert is_price_variance_flagged(Decimal("310.00"), Decimal("300.00")) is True


def test_is_price_variance_flagged_at_exact_boundary_not_flagged():
    # Exactly at tolerance (not strictly greater than) must not flag.
    assert is_price_variance_flagged(Decimal("3.50"), Decimal("3.00")) is False  # diff == 0.50 floor, not > it
    assert is_price_variance_flagged(Decimal("306.00"), Decimal("300.00")) is False  # diff == 6.00 == 2%, not > it


def test_compute_sale_totals_floors_total_at_zero():
    totals = compute_sale_totals(
        [LineItemInput(quantity=1, unit_price=Decimal("15.00"), catalog_unit_price=Decimal("15.00"))],
        discount_type="fixed",
        discount_value=Decimal("999.00"),
        tax_amount=Decimal("0.00"),
    )
    assert totals.discount_amount == Decimal("15.00")
    assert totals.total_amount == Decimal("0.00")


def test_compute_sale_totals_price_variance_flagged_is_or_across_lines():
    totals = compute_sale_totals(
        [
            LineItemInput(quantity=1, unit_price=Decimal("15.00"), catalog_unit_price=Decimal("15.00")),
            LineItemInput(quantity=1, unit_price=Decimal("310.00"), catalog_unit_price=Decimal("300.00")),
        ],
        discount_type="fixed",
        discount_value=Decimal("0.00"),
        tax_amount=Decimal("0.00"),
    )
    assert [line.price_variance_flagged for line in totals.line_items] == [False, True]
    assert totals.price_variance_flagged is True
