"""Concurrent writes to the same stock_levels row must not lose updates.

Found in code review, on live code. Both POST /api/v1/sales and POST
/api/v1/stock/adjustments read a StockLevel row with a plain SELECT, do the
arithmetic in Python, and write back an ABSOLUTE value
(`level.quantity -= n`, so SQLAlchemy emits `SET quantity = <computed>`,
not `SET quantity = quantity - n`). Under Postgres READ COMMITTED a plain
SELECT takes no row lock, so two concurrent transactions against the same
(product_id, outlet_id) both read the same starting quantity, both pass the
availability check, and the second commit silently overwrites the first.

Nothing catches it: no lock, no relative update, no CHECK constraint on
stock_levels.quantity, and no serialization failure to surface as an error.
Stock simply ends up wrong, and can go negative.

This is not an adversarial scenario — it is two cashiers on two devices, or
one device flushing a batch of queued offline sales after an outage, which
is this app's normal operating mode.

POSTGRES ONLY. The suite's SQLite mode shares a single in-memory connection
across sessions, so these requests serialize at the driver and the race
cannot occur — a green SQLite run here would be meaningless rather than
reassuring. CI's api-tests-postgres job is what actually exercises this
(see .github/workflows/ci.yml), which is the same reason that job exists for
NUMERIC(12,2) and FK enforcement.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from sqlalchemy import select

from app.models import Sale, StockLevel, StockMovement

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason=(
        "Requires real Postgres: SQLite's shared in-memory connection serializes "
        "these requests at the driver, so the lost-update race cannot occur and a "
        "pass would prove nothing. Run with DATABASE_URL set (CI's "
        "api-tests-postgres job does)."
    ),
)


async def _set_stock(session_factory, product_id, outlet_id, quantity: int) -> None:
    async with session_factory() as session:
        level = (
            await session.execute(
                select(StockLevel).where(
                    StockLevel.product_id == product_id, StockLevel.outlet_id == outlet_id
                )
            )
        ).scalar_one()
        level.quantity = quantity
        await session.commit()


async def _read_stock(session_factory, product_id, outlet_id) -> int:
    async with session_factory() as session:
        return (
            await session.execute(
                select(StockLevel.quantity).where(
                    StockLevel.product_id == product_id, StockLevel.outlet_id == outlet_id
                )
            )
        ).scalar_one()


def _sale_body(product_id, outlet_id, quantity: int) -> dict:
    return {
        "client_id": str(uuid.uuid4()),
        "outlet_id": str(outlet_id),
        "line_items": [
            {
                "product_id": str(product_id),
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


async def test_two_concurrent_sales_cannot_oversell_the_same_product(client):
    """Stock 5, two concurrent sales of 3. Exactly one may succeed.

    Without a row lock both reads see 5, both pass `available < quantity`,
    and both commit — selling 6 units of a 5-unit stock.
    """
    product_id = client.seed["product_id"]
    outlet_id = client.seed["outlet_id"]
    await _set_stock(client.session_factory, product_id, outlet_id, 5)

    first, second = await asyncio.gather(
        client.post("/api/v1/sales", json=_sale_body(product_id, outlet_id, 3)),
        client.post("/api/v1/sales", json=_sale_body(product_id, outlet_id, 3)),
        return_exceptions=False,
    )

    codes = sorted([first.status_code, second.status_code])
    assert codes == [201, 409], (
        f"expected exactly one sale to succeed and one to be rejected for "
        f"insufficient stock, got {codes}: {first.text} | {second.text}"
    )

    rejected = first if first.status_code == 409 else second
    assert rejected.json()["error"]["code"] == "INSUFFICIENT_STOCK"

    remaining = await _read_stock(client.session_factory, product_id, outlet_id)
    assert remaining == 2, f"stock should be 5 - 3 = 2, got {remaining}"


async def test_concurrent_sales_never_drive_stock_negative(client):
    """Four concurrent sales of 3 against a stock of 5.

    Whatever interleaving occurs, stock must never end below zero — that is
    the invariant a corrupted quantity breaks permanently, since every later
    availability check reads from it.
    """
    product_id = client.seed["product_id"]
    outlet_id = client.seed["outlet_id"]
    await _set_stock(client.session_factory, product_id, outlet_id, 5)

    responses = await asyncio.gather(
        *(client.post("/api/v1/sales", json=_sale_body(product_id, outlet_id, 3)) for _ in range(4))
    )

    succeeded = [r for r in responses if r.status_code == 201]
    assert len(succeeded) == 1, (
        f"only one sale of 3 fits in a stock of 5; {len(succeeded)} succeeded: "
        + " | ".join(r.text for r in responses)
    )

    remaining = await _read_stock(client.session_factory, product_id, outlet_id)
    assert remaining >= 0, f"stock went negative: {remaining}"
    assert remaining == 2


async def test_stock_movements_match_the_committed_quantity(client):
    """The audit trail must reconcile with the cache.

    stock_movements is the ledger and stock_levels is a cache of its sum. A
    lost update desynchronizes them silently: two movements of -3 recorded
    against a cache that only moved by 3.
    """
    product_id = client.seed["product_id"]
    outlet_id = client.seed["outlet_id"]
    await _set_stock(client.session_factory, product_id, outlet_id, 10)

    await asyncio.gather(
        *(client.post("/api/v1/sales", json=_sale_body(product_id, outlet_id, 2)) for _ in range(3))
    )

    async with client.session_factory() as session:
        movements = (
            await session.execute(
                select(StockMovement.delta).where(
                    StockMovement.product_id == product_id,
                    StockMovement.outlet_id == outlet_id,
                    StockMovement.reason == "sale",
                )
            )
        ).scalars().all()
        sales_count = len(
            (await session.execute(select(Sale.id).where(Sale.outlet_id == outlet_id))).scalars().all()
        )

    remaining = await _read_stock(client.session_factory, product_id, outlet_id)
    assert remaining == 10 + sum(movements), (
        f"stock_levels ({remaining}) does not reconcile with the movement ledger "
        f"(10 + {sum(movements)}); {sales_count} sales, {len(movements)} movements"
    )
