"""Two concurrent writes with the SAME client_id must produce exactly one row.

The suite already covers sequential replay — POST, then POST the same intent
again, get the original back. That path is the easy one: the pre-check at the
top of each handler sees the existing row and returns it before any write.

What was untested is the branch underneath it. When two requests carrying the
same client_id arrive close enough together that BOTH pass the pre-check,
neither can see the other's uncommitted row, so both proceed to write. The
database's UNIQUE constraint catches the loser at commit time, and each
router has an `except IntegrityError` branch that rolls back, re-reads the
winner, and returns it as an idempotent replay.

Code review found those branches had zero coverage — `grep IntegrityError
tests/` returned nothing across all three routers. They are the last line of
the idempotency contract (design.md §3.4): the offline queue retries, and a
retry that overlaps its own original is exactly the case this handles. A
device reconnecting mid-dispatch produces it without anything unusual
happening.

POSTGRES ONLY, for the same reason as tests/test_stock_concurrency.py:
SQLite's shared in-memory connection serializes these requests at the driver,
so the second never overlaps the first, the pre-check always catches it, and
the IntegrityError branch is never reached. A green SQLite run here would
prove only that sequential replay works — which is already covered elsewhere.

WHAT THESE TESTS ACTUALLY REACH — measured, not assumed. Sabotaging each
`except IntegrityError` branch (making it raise) and re-running shows:

  sales  (both tests)  FAIL  -> the recovery branch is genuinely exercised
  stock  adjustments   FAIL  -> genuinely exercised
  expenses             PASS  -> NOT exercised

The expenses handler does less work between its pre-check and its commit, so
the second request loses the race and its pre-check sees the first's
committed row — the outcome is right, but it is delivered by the pre-check,
not by IntegrityError recovery. That test therefore asserts the INVARIANT
(one expense, one replay) without covering the branch underneath it, and
routers/expenses.py's recovery path remains formally untested.

It is kept because the invariant is worth pinning and because the timing
could shift either way on different hardware. It is documented here because
a test that looks like branch coverage and isn't is worse than a known gap —
that assumption is what left these branches untested in the first place.
"""
from __future__ import annotations

import asyncio
import os

import pytest
from sqlalchemy import func, select

from app.models import Expense, Sale, StockLevel, StockMovement

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason=(
        "Requires real Postgres: SQLite serializes these requests at the driver, so "
        "both never pass the pre-check and the IntegrityError branch under test is "
        "never reached. CI's api-tests-postgres job runs these."
    ),
)

SAME_CLIENT_ID = "race-same-client-id-0001"


def _sale_payload(seed, *, client_id: str, quantity: int = 2) -> dict:
    return {
        "client_id": client_id,
        "outlet_id": str(seed["outlet_id"]),
        "line_items": [
            {
                "product_id": str(seed["product_id"]),
                "quantity": quantity,
                "submitted_unit_price": "15.00",
            }
        ],
        "payment_method": "cash",
        "discount_type": "fixed",
        "discount_value": "0.00",
        "tax_amount": "0.00",
        "device_recorded_at": "2026-01-01T00:00:00Z",
    }


async def _count(session_factory, model, **filters) -> int:
    async with session_factory() as session:
        stmt = select(func.count()).select_from(model)
        for column, value in filters.items():
            stmt = stmt.where(getattr(model, column) == value)
        return (await session.execute(stmt)).scalar_one()


async def _stock_quantity(session_factory, product_id, outlet_id) -> int:
    async with session_factory() as session:
        return (
            await session.execute(
                select(StockLevel.quantity).where(
                    StockLevel.product_id == product_id, StockLevel.outlet_id == outlet_id
                )
            )
        ).scalar_one()


def _assert_one_fresh_one_replay(first, second, *, id_field: str = "id") -> None:
    """Whichever order they land in: one 201 fresh write, one 200 replay of it."""
    statuses = sorted([first.status_code, second.status_code])
    assert statuses == [200, 201], (
        f"expected one 201 and one 200 replay, got {statuses}: {first.text} | {second.text}"
    )

    created = first if first.status_code == 201 else second
    replayed = second if first.status_code == 201 else first

    assert created.json()["idempotent_replay"] is False
    assert replayed.json()["idempotent_replay"] is True, (
        "the losing request must be reported as a replay, not as a fresh write"
    )
    assert replayed.json()[id_field] == created.json()[id_field], (
        "the replay must return the winner's row, not a second row"
    )


async def test_concurrent_sales_with_one_client_id_create_one_sale(client):
    seed = client.seed
    before = await _stock_quantity(client.session_factory, seed["product_id"], seed["outlet_id"])

    first, second = await asyncio.gather(
        client.post("/api/v1/sales", json=_sale_payload(seed, client_id=SAME_CLIENT_ID)),
        client.post("/api/v1/sales", json=_sale_payload(seed, client_id=SAME_CLIENT_ID)),
    )

    _assert_one_fresh_one_replay(first, second)
    assert await _count(client.session_factory, Sale, client_id=SAME_CLIENT_ID) == 1

    after = await _stock_quantity(client.session_factory, seed["product_id"], seed["outlet_id"])
    assert after == before - 2, (
        f"stock must move once, not twice: {before} -> {after} for a single sale of 2"
    )


async def test_concurrent_sales_with_one_client_id_write_one_movement(client):
    """The ledger must not gain a phantom entry from the losing request.

    A rolled-back loser that still left its stock_movements rows behind would
    desynchronize the ledger from stock_levels exactly like a lost update,
    just from the opposite direction.
    """
    seed = client.seed
    await asyncio.gather(
        client.post("/api/v1/sales", json=_sale_payload(seed, client_id=SAME_CLIENT_ID)),
        client.post("/api/v1/sales", json=_sale_payload(seed, client_id=SAME_CLIENT_ID)),
    )

    movements = await _count(
        client.session_factory, StockMovement, client_id=SAME_CLIENT_ID, reason="sale"
    )
    assert movements == 1, f"one line item, one sale — expected 1 movement, found {movements}"


async def test_concurrent_stock_adjustments_with_one_client_id_apply_once(client):
    seed = client.seed
    before = await _stock_quantity(client.session_factory, seed["product_id"], seed["outlet_id"])
    payload = {
        "client_id": SAME_CLIENT_ID,
        "product_id": str(seed["product_id"]),
        "outlet_id": str(seed["outlet_id"]),
        "delta": -3,
        "reason": "adjustment",
    }

    first, second = await asyncio.gather(
        client.post("/api/v1/stock/adjustments", json=payload),
        client.post("/api/v1/stock/adjustments", json=payload),
    )

    _assert_one_fresh_one_replay(first, second)
    assert (
        await _count(client.session_factory, StockMovement, client_id=SAME_CLIENT_ID) == 1
    )

    after = await _stock_quantity(client.session_factory, seed["product_id"], seed["outlet_id"])
    assert after == before - 3, f"delta applied twice: {before} -> {after} for a single -3"


async def test_concurrent_expenses_with_one_client_id_create_one_expense(client):
    seed = client.seed
    payload = {
        "client_id": SAME_CLIENT_ID,
        "outlet_id": str(seed["outlet_id"]),
        "amount": "50.00",
        "category": "utilities",
        "note": "generator fuel",
        "device_recorded_at": "2026-01-01T00:00:00Z",
    }

    # See the module docstring: this one is satisfied by the pre-check rather
    # than by IntegrityError recovery, so it pins the invariant, not the branch.
    first, second = await asyncio.gather(
        client.post("/api/v1/expenses", json=payload),
        client.post("/api/v1/expenses", json=payload),
    )

    _assert_one_fresh_one_replay(first, second)
    assert await _count(client.session_factory, Expense, client_id=SAME_CLIENT_ID) == 1
