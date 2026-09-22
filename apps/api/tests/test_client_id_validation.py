"""client_id must be a UUID.

Its uniqueness is enforced GLOBALLY — `sales.client_id` is UNIQUE across the
whole table, not per outlet — so client_id is one namespace shared by every
tenant. `app/authz.py`'s `assert_client_id_not_another_tenants` makes a
collision SAFE (409, rather than returning or discarding someone's write).
This closes the other half: the ability to pick a colliding id at all.

The vector without it is squatting, not disclosure. A modified client sends
`client_id: "1"`, and thereafter any other tenant whose tooling happens to
use "1" is refused. Random UUIDs make that infeasible rather than merely
detected.

Enforcement costs something real, recorded here so the cost is not
rediscovered as a surprise: 78 fixtures across six files previously carried
readable ids like "adj-oversell". They now go through `cid()`
(tests/conftest.py), which maps a label to a stable uuid5 — the call site
still reads as a label, the wire value is a real UUID.
"""
from __future__ import annotations

import uuid

import pytest

from app.schemas import validate_client_id
from tests.conftest import cid


# --- the validator itself -------------------------------------------------


def test_accepts_a_uuid():
    value = str(uuid.uuid4())
    assert validate_client_id(value) == value


def test_accepts_any_uuid_version():
    """uuid5 is what tests/conftest.py's cid() produces, and uuid1 is a
    plausible client choice. Neither should be refused for its version."""
    for value in (str(uuid.uuid1()), cid("some-label")):
        assert validate_client_id(value) == value


def test_rejects_a_short_guessable_id():
    """The squatting vector: "1" is trivially collided with on purpose."""
    with pytest.raises(ValueError):
        validate_client_id("1")


def test_rejects_a_readable_label():
    with pytest.raises(ValueError):
        validate_client_id("adj-oversell")


def test_rejects_an_empty_string():
    with pytest.raises(ValueError):
        validate_client_id("")


def test_rejects_a_uuid_with_trailing_content():
    with pytest.raises(ValueError):
        validate_client_id(f"{uuid.uuid4()}-extra")


def test_does_not_normalize_case():
    """The value is stored and compared verbatim. Normalising would silently
    change what counts as a replay for a client that echoes back the id it
    generated — and packages/offline-queue never regenerates one."""
    upper = str(uuid.uuid4()).upper()
    assert validate_client_id(upper) == upper


# --- enforced at every write endpoint -------------------------------------


def _sale(seed, client_id):
    return {
        "client_id": client_id,
        "outlet_id": str(seed["outlet_id"]),
        "line_items": [{"product_id": str(seed["product_id"]), "quantity": 1,
                        "submitted_unit_price": "15.00"}],
        "payment_method": "cash",
        "discount_type": "fixed",
        "discount_value": "0.00",
        "tax_amount": "0.00",
        "device_recorded_at": "2026-01-01T00:00:00Z",
    }


async def test_sales_rejects_a_non_uuid_client_id(client):
    resp = await client.post("/api/v1/sales", json=_sale(client.seed, "not-a-uuid"))
    assert resp.status_code == 422, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_stock_adjustments_rejects_a_non_uuid_client_id(client):
    resp = await client.post("/api/v1/stock/adjustments", json={
        "client_id": "adj-1",
        "product_id": str(client.seed["product_id"]),
        "outlet_id": str(client.seed["outlet_id"]),
        "delta": -1,
        "reason": "adjustment",
    })
    assert resp.status_code == 422, resp.text


async def test_expenses_rejects_a_non_uuid_client_id(client):
    resp = await client.post("/api/v1/expenses", json={
        "client_id": "exp-1",
        "outlet_id": str(client.seed["outlet_id"]),
        "amount": "50.00",
        "category": "utilities",
        "device_recorded_at": "2026-01-01T00:00:00Z",
    })
    assert resp.status_code == 422, resp.text


async def test_a_uuid_client_id_still_works_end_to_end(client):
    """The guard must not break the path it sits in front of."""
    resp = await client.post("/api/v1/sales", json=_sale(client.seed, cid("validation-happy-path")))
    assert resp.status_code == 201, resp.text


# --- the test helper it forced ---------------------------------------------


def test_cid_produces_a_real_uuid():
    uuid.UUID(cid("anything"))


def test_cid_is_stable_across_calls():
    """A replay test that generated a fresh id each call would not replay."""
    assert cid("same-label") == cid("same-label")


def test_cid_distinguishes_labels():
    assert cid("adj-1") != cid("adj-2")
