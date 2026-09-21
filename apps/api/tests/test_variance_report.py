"""scripts/variance_report.py — the formatting that decides whether anyone reads it.

The daily variance review is a pilot gate, and the way such a gate fails is
not that the query breaks: it is that the output is tedious enough that the
person stops opening it after a week. So what is tested here is that a
variance is stated plainly — direction, amount, percentage — rather than
left as two numbers for the reader to subtract.
"""
from __future__ import annotations

from decimal import Decimal

from scripts.variance_report import describe_line, money


def _line(charged, catalog, *, name="Outre Braid", qty=1, flagged=True):
    return {
        "product_name": name,
        "quantity": qty,
        "unit_price": charged,
        "catalog_unit_price_at_sale": catalog,
        "price_variance_flagged": flagged,
    }


def test_money_parses_to_decimal_never_float():
    """CLAUDE.md: never floats for money. 0.1 + 0.2 arithmetic in a report
    that is meant to reconcile against a till is its own bug."""
    assert money("27.50") == Decimal("27.50")
    assert isinstance(money("27.50"), Decimal)


def test_reports_an_undercharge_as_UNDER():
    """The direction that matters: sold below catalog is the skimming shape."""
    out = describe_line(_line("5.00", "15.00"))
    assert "UNDER" in out
    assert "10.00" in out


def test_reports_an_overcharge_as_over():
    out = describe_line(_line("20.00", "15.00"))
    assert "over" in out and "UNDER" not in out


def test_states_the_gap_so_the_reader_does_not_subtract():
    out = describe_line(_line("5.00", "15.00"))
    assert "10.00" in out, "the difference itself must appear, not only the two prices"


def test_includes_a_percentage_for_scale():
    """GHS 10 off a GHS 15 item and GHS 10 off a GHS 1,500 wig are different
    events; the percentage is what separates them at a glance."""
    assert "67%" in describe_line(_line("5.00", "15.00"))
    assert "1%" in describe_line(_line("1490.00", "1500.00"))


def test_shows_both_prices():
    out = describe_line(_line("5.00", "15.00"))
    assert "5.00" in out and "15.00" in out


def test_shows_quantity_because_the_gap_multiplies():
    out = describe_line(_line("5.00", "15.00", qty=40))
    assert "40" in out


def test_survives_a_zero_catalog_price():
    """A free or mispriced item must not crash the report with a division by
    zero — the reviewer still needs to see the rest of the day."""
    out = describe_line(_line("5.00", "0.00"))
    assert "5.00" in out


def test_truncates_a_long_product_name_without_losing_the_numbers():
    long_name = "Hiluxury Yaki 8 Inch 4pcs Closure Black Extra Long Edition"
    out = describe_line(_line("5.00", "15.00", name=long_name))
    assert "UNDER" in out and "10.00" in out
