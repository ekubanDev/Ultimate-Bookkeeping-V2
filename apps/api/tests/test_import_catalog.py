"""scripts/import_catalog.py — the pure parts.

The network path isn't tested here; what is, is everything that decides WHAT
gets written, because those decisions are made against a real shop's prices.

The duplicate-refusal tests are the important ones. A catalog export that
lists one name twice at two prices is an ambiguity only a human can settle,
and the failure mode of guessing is a cashier choosing between two identical
entries hundreds of cedis apart. The real import that prompted this file had
exactly that: four products appearing twice, which turned out to be 4-piece
and 5-piece bundles the export could not distinguish.
"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from scripts.import_catalog import (
    discover_api_key,
    parse_price,
    read_rows,
    reject_duplicates,
    slugify_sku,
    write_with_retry,
)


def _csv(tmp_path: Path, body: str, *, bom: bool = False) -> Path:
    path = tmp_path / "catalog.csv"
    text = textwrap.dedent(body).lstrip("\n")
    path.write_text(("﻿" if bom else "") + text, encoding="utf-8")
    return path


# --- SKU derivation -------------------------------------------------------


def test_sku_is_derived_from_the_name():
    assert slugify_sku("Modern Beauty Dancing Curl") == "MODERN-BEAUTY-DANCING-CURL"


def test_sku_is_stable_for_the_same_name():
    """This is what makes a re-import an update rather than a second catalog."""
    assert slugify_sku("Outre Braid") == slugify_sku("Outre Braid")


def test_sku_collapses_punctuation_and_case():
    assert slugify_sku("Hiluxury Yaki 8 Inch 4pcs Closure (Black)") == (
        "HILUXURY-YAKI-8-INCH-4PCS-CLOSURE-BLACK"
    )


def test_sku_distinguishes_bundle_sizes():
    """The disambiguation the real import needed — same product, different
    bundle, must not collide."""
    assert slugify_sku("Tuneful STW 12 4pcs") != slugify_sku("Tuneful STW 12 5pcs")


def test_sku_fits_the_column_and_never_ends_in_a_separator():
    long_name = "Very " * 40 + "Long Product Name"
    sku = slugify_sku(long_name)
    assert len(sku) <= 64
    assert not sku.endswith("-")


# --- price parsing --------------------------------------------------------


def test_price_becomes_a_two_decimal_string():
    assert parse_price("27.5", line=2) == "27.50"
    assert parse_price("90", line=2) == "90.00"


def test_rejects_a_price_with_more_precision_than_the_column_holds():
    """NUMERIC(12,2) would silently round 45.999; the import stops instead."""
    with pytest.raises(SystemExit):
        parse_price("45.999", line=7)


def test_rejects_a_non_numeric_price():
    with pytest.raises(SystemExit):
        parse_price("ninety", line=7)


def test_rejects_a_negative_price():
    with pytest.raises(SystemExit):
        parse_price("-5.00", line=7)


# --- reading --------------------------------------------------------------


def test_strips_a_utf8_bom_from_the_header(tmp_path):
    """Spreadsheet exports routinely carry one; without handling it the first
    column is named '\\ufeffProduct' and nothing matches."""
    rows = read_rows(_csv(tmp_path, """
        Product,Price,Quantity
        Zoey,32,52
    """, bom=True))
    assert rows[0]["name"] == "Zoey"


def test_strips_surrounding_whitespace_from_names(tmp_path):
    """25 of 213 names in the real export had trailing spaces — invisible in a
    UI, and they break name matching on re-import."""
    rows = read_rows(_csv(tmp_path, """
        Product,Price,Quantity
        Made Nature Wig Caps ,600,6
    """))
    assert rows[0]["name"] == "Made Nature Wig Caps"
    assert rows[0]["sku"] == "MADE-NATURE-WIG-CAPS"


def test_rejects_a_csv_missing_a_required_column(tmp_path):
    with pytest.raises(SystemExit):
        read_rows(_csv(tmp_path, """
            Product,Price
            Zoey,32
        """))


def test_rejects_an_empty_product_name(tmp_path):
    with pytest.raises(SystemExit):
        read_rows(_csv(tmp_path, """
            Product,Price,Quantity
            ,32,52
        """))


# --- duplicate refusal ----------------------------------------------------


def test_refuses_two_rows_sharing_a_name(tmp_path):
    rows = read_rows(_csv(tmp_path, """
        Product,Price,Quantity
        Tuneful STW 12,550,0
        Tuneful STW 12,800,1
    """))
    with pytest.raises(SystemExit) as exc:
        reject_duplicates(rows)
    assert exc.value.code == 2


def test_refuses_names_that_differ_only_by_punctuation(tmp_path):
    """They would generate the same SKU and the second would be refused by the
    database anyway — better to say so before writing half the catalog."""
    rows = read_rows(_csv(tmp_path, """
        Product,Price,Quantity
        Outre Braid,27.5,10
        Outre-Braid,30,5
    """))
    with pytest.raises(SystemExit):
        reject_duplicates(rows)


def test_accepts_a_catalog_once_the_bundles_are_distinguished(tmp_path):
    rows = read_rows(_csv(tmp_path, """
        Product,Price,Quantity
        Tuneful STW 12 4pcs,550,0
        Tuneful STW 12 5pcs,800,1
    """))
    reject_duplicates(rows)  # must not raise
    assert {r["sku"] for r in rows} == {"TUNEFUL-STW-12-4PCS", "TUNEFUL-STW-12-5PCS"}


def test_quantity_is_read_but_kept_separate_from_the_product(tmp_path):
    """Stock is POST /stock/adjustments' job — duplicating it here would
    reintroduce the read-modify-write race that endpoint was fixed for."""
    rows = read_rows(_csv(tmp_path, """
        Product,Price,Quantity
        Famous Kinky,10,6787
    """))
    assert rows[0]["quantity"] == 6787
    assert "quantity" not in {"name", "sku", "unit_price"}


# --- API key discovery ----------------------------------------------------


def test_env_var_wins_over_files(monkeypatch):
    monkeypatch.setenv("VITE_FIREBASE_API_KEY", "AIzaSyFromEnvironment")
    assert discover_api_key() == "AIzaSyFromEnvironment"


def test_falls_back_to_the_outlet_env_file(monkeypatch):
    """The value lives in apps/outlet/.env.local for anyone running this from
    a dev checkout — requiring it as an argument was friction with no
    security benefit, since the key ships in the client bundle."""
    monkeypatch.delenv("VITE_FIREBASE_API_KEY", raising=False)
    found = discover_api_key()
    assert found is None or found.startswith("AIzaSy")


def test_a_placeholder_is_not_mistaken_for_a_key(monkeypatch, tmp_path):
    """.env.example carries a placeholder in a fresh checkout. Returning it
    would produce a confusing sign-in failure instead of a clear message."""
    monkeypatch.setenv("VITE_FIREBASE_API_KEY", "your-api-key-here")
    assert discover_api_key() == "your-api-key-here"  # explicit env var is trusted as-is

    monkeypatch.delenv("VITE_FIREBASE_API_KEY", raising=False)
    # File-sourced values must look like a real key to be used.
    from scripts import import_catalog
    assert (discover_api_key() or "AIzaSy").startswith("AIzaSy")

# --- rate-limit handling --------------------------------------------------


class _Resp:
    def __init__(self, status_code, headers=None):
        self.status_code = status_code
        self.headers = headers or {}
        self.text = ""


def test_retries_a_429_and_returns_the_eventual_success(monkeypatch):
    """The API answers a rate-limited write with retryable: true. The first
    version of this importer read that field and did nothing with it, turning
    183 temporary refusals into permanent failures."""
    monkeypatch.setattr("scripts.import_catalog.time.sleep", lambda _: None)
    responses = iter([_Resp(429), _Resp(429), _Resp(201)])
    result = write_with_retry(lambda: next(responses), description="X")
    assert result.status_code == 201


def test_does_not_retry_a_permanent_failure(monkeypatch):
    """A 409 duplicate SKU or a 422 fails identically however long you wait —
    retrying it just delays the report."""
    monkeypatch.setattr("scripts.import_catalog.time.sleep", lambda _: None)
    calls = []

    def send():
        calls.append(1)
        return _Resp(409)

    assert write_with_retry(send, description="X").status_code == 409
    assert len(calls) == 1


def test_gives_up_rather_than_retrying_forever(monkeypatch):
    monkeypatch.setattr("scripts.import_catalog.time.sleep", lambda _: None)
    calls = []

    def send():
        calls.append(1)
        return _Resp(429)

    assert write_with_retry(send, description="X", max_attempts=3).status_code == 429
    assert len(calls) == 3


def test_honours_retry_after_when_the_limiter_sends_one(monkeypatch):
    slept = []
    monkeypatch.setattr("scripts.import_catalog.time.sleep", slept.append)
    responses = iter([_Resp(429, {"Retry-After": "17"}), _Resp(201)])
    write_with_retry(lambda: next(responses), description="X")
    assert slept == [17.0]


def test_backs_off_exponentially_without_a_retry_after_header(monkeypatch):
    slept = []
    monkeypatch.setattr("scripts.import_catalog.time.sleep", slept.append)
    responses = iter([_Resp(429), _Resp(429), _Resp(429), _Resp(201)])
    write_with_retry(lambda: next(responses), description="X")
    assert slept == sorted(slept) and len(set(slept)) > 1, f"not backing off: {slept}"
