"""A client_id belonging to another tenant is not this caller's replay.

Every write endpoint looks its `client_id` up FIRST, before resolving or
authorizing an outlet (design.md §3.4 step 1: a replayed intent must never
fail differently than it did the first time). That lookup is global —
`sales.client_id` is UNIQUE across the whole table, not per outlet — so
`client_id` is one namespace shared by every tenant in the system.

Before app/authz.py's `assert_client_id_not_another_tenants`, a collision
was indistinguishable from a legitimate replay, and the handler returned the
OTHER tenant's row. Two consequences, the second worse than the first:

  1. Disclosure — the caller receives another business's sale id, amounts,
     timestamps and variance flag.
  2. A silently discarded write — the caller's real sale is treated as a
     duplicate and never recorded. Money missing from the books, no error.

Not currently reachable by accident: clients send UUIDv4, so collisions are
negligible and guessing one is infeasible. It is reachable on purpose,
because the schema accepts any non-empty string — `client_id: str =
Field(min_length=1)` — so a modified client can simply pick "1". See the
README known-gaps entry on validating client_id as a UUID, which would also
close the remaining denial vector (squatting an id another tenant then
cannot use).
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import select

from app.models import Expense, Outlet, Product, Sale, StockLevel, StockMovement, User

SHARED_CLIENT_ID = "collision-across-tenants"


async def _create_other_tenant_sale(client, *, client_id: str) -> dict:
    """A complete foreign tenant that already owns `client_id`."""
    ids = {
        "admin_id": uuid.uuid4(),
        "outlet_id": uuid.uuid4(),
        "product_id": uuid.uuid4(),
    }
    async with client.session_factory() as session:
        session.add(User(id=ids["admin_id"], role="admin", display_name="Other Admin"))
        await session.flush()
        session.add(Outlet(id=ids["outlet_id"], admin_id=ids["admin_id"], name="Other Outlet"))
        session.add(
            Product(
                id=ids["product_id"],
                admin_id=ids["admin_id"],
                sku="OTHER-SKU",
                name="Other Widget",
                unit_price=Decimal("9.00"),
            )
        )
        await session.flush()
        session.add(
            Sale(
                id=uuid.uuid4(),
                outlet_id=ids["outlet_id"],
                client_id=client_id,
                subtotal_amount=Decimal("999.00"),
                discount_amount=Decimal("0.00"),
                tax_amount=Decimal("0.00"),
                total_amount=Decimal("999.00"),
                payment_method="cash",
            )
        )
        await session.commit()
    return ids


def _sale_payload(seed, *, client_id: str) -> dict:
    return {
        "client_id": client_id,
        "outlet_id": str(seed["outlet_id"]),
        "line_items": [
            {
                "product_id": str(seed["product_id"]),
                "quantity": 1,
                "submitted_unit_price": "15.00",
            }
        ],
        "payment_method": "cash",
        "discount_type": "fixed",
        "discount_value": "0.00",
        "tax_amount": "0.00",
        "device_recorded_at": "2026-01-01T00:00:00Z",
    }


async def test_sale_with_another_tenants_client_id_is_refused(client):
    await _create_other_tenant_sale(client, client_id=SHARED_CLIENT_ID)

    resp = await client.post(
        "/api/v1/sales", json=_sale_payload(client.seed, client_id=SHARED_CLIENT_ID)
    )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "CLIENT_ID_CONFLICT"


async def test_the_other_tenants_sale_is_never_disclosed(client):
    """The refusal must not carry the foreign row's contents."""
    await _create_other_tenant_sale(client, client_id=SHARED_CLIENT_ID)

    resp = await client.post(
        "/api/v1/sales", json=_sale_payload(client.seed, client_id=SHARED_CLIENT_ID)
    )

    body = resp.text
    assert "999.00" not in body, "the other tenant's total leaked into the response"
    assert "idempotent_replay" not in body, "refusal must not be shaped like a replay"


async def test_the_refusal_is_not_retryable(client):
    """Replaying the same client_id can never succeed, so the offline queue
    must surface it for resolution rather than retry forever."""
    await _create_other_tenant_sale(client, client_id=SHARED_CLIENT_ID)

    resp = await client.post(
        "/api/v1/sales", json=_sale_payload(client.seed, client_id=SHARED_CLIENT_ID)
    )

    assert resp.json()["error"]["retryable"] is False


async def test_own_replay_still_works(client):
    """The guard must not break the legitimate case it sits in front of."""
    payload = _sale_payload(client.seed, client_id="my-own-client-id")

    first = await client.post("/api/v1/sales", json=payload)
    second = await client.post("/api/v1/sales", json=payload)

    assert first.status_code == 201, first.text
    assert second.status_code == 200, second.text
    assert second.json()["idempotent_replay"] is True
    assert second.json()["id"] == first.json()["id"]


async def test_expense_with_another_tenants_client_id_is_refused(client):
    other = await _create_other_tenant_sale(client, client_id="other-expense-cid")
    async with client.session_factory() as session:
        session.add(
            Expense(
                id=uuid.uuid4(),
                outlet_id=other["outlet_id"],
                client_id="expense-collision",
                amount=Decimal("500.00"),
                category="rent",
            )
        )
        await session.commit()

    resp = await client.post(
        "/api/v1/expenses",
        json={
            "client_id": "expense-collision",
            "outlet_id": str(client.seed["outlet_id"]),
            "amount": "50.00",
            "category": "utilities",
            "note": "generator fuel",
            "device_recorded_at": "2026-01-01T00:00:00Z",
        },
    )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "CLIENT_ID_CONFLICT"
    assert "500.00" not in resp.text


async def test_stock_adjustment_with_another_tenants_client_id_is_refused(client):
    other = await _create_other_tenant_sale(client, client_id="other-adj-cid")
    async with client.session_factory() as session:
        session.add(
            StockMovement(
                id=uuid.uuid4(),
                product_id=other["product_id"],
                outlet_id=other["outlet_id"],
                delta=-5,
                reason="adjustment",
                client_id="adjustment-collision",
            )
        )
        await session.commit()

    resp = await client.post(
        "/api/v1/stock/adjustments",
        json={
            "client_id": "adjustment-collision",
            "product_id": str(client.seed["product_id"]),
            "outlet_id": str(client.seed["outlet_id"]),
            "delta": -1,
            "reason": "adjustment",
        },
    )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "CLIENT_ID_CONFLICT"


async def test_the_callers_own_write_is_not_silently_discarded(client):
    """The bug's worse half: the caller's sale must not vanish without a word.

    The load-bearing assertion here is that the caller is TOLD. Asserting
    only "no sale row exists" would pass with or without the guard — before
    it, the write also produced no row, it just returned 200 pretending to be
    a replay. A caller cannot distinguish that from success, which is exactly
    how a sale goes missing from the books unnoticed.
    """
    await _create_other_tenant_sale(client, client_id=SHARED_CLIENT_ID)

    resp = await client.post(
        "/api/v1/sales", json=_sale_payload(client.seed, client_id=SHARED_CLIENT_ID)
    )

    assert resp.status_code == 409, (
        f"the caller must be told the write did not happen, got {resp.status_code}: {resp.text}"
    )

    async with client.session_factory() as session:
        mine = (
            await session.execute(
                select(Sale).where(Sale.outlet_id == client.seed["outlet_id"])
            )
        ).scalars().all()
    assert mine == [], "refused outright, not partially applied"

    # And the refusal is recoverable: a new client_id goes through.
    retry = await client.post(
        "/api/v1/sales", json=_sale_payload(client.seed, client_id="a-fresh-client-id")
    )
    assert retry.status_code == 201, retry.text
