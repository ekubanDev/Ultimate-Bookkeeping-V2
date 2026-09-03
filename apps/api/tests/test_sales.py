from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import select

from app.models import Product, Sale, SaleLineItem, StockLevel, StockMovement, User


def _sale_payload(seed, *, client_id="client-1", quantity=2, unit_price="15.00", tax="3.00", discount="0.00"):
    return {
        "client_id": client_id,
        "outlet_id": str(seed["outlet_id"]),
        "line_items": [
            {"product_id": str(seed["product_id"]), "quantity": quantity, "unit_price": unit_price}
        ],
        "payment_method": "mobile_money",
        "discount_amount": discount,
        "tax_amount": tax,
        "device_recorded_at": "2026-08-31T18:42:03Z",
    }


async def _stock_qty(client, product_id, outlet_id) -> int:
    async with client.session_factory() as session:
        result = await session.execute(
            select(StockLevel).where(StockLevel.product_id == product_id, StockLevel.outlet_id == outlet_id)
        )
        level = result.scalar_one()
        return level.quantity


async def test_happy_path_creates_sale_and_decrements_stock(client):
    seed = client.seed
    resp = await client.post("/api/v1/sales", json=_sale_payload(seed))

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "completed"
    assert body["total_amount"] == "33.00"  # (2 * 15.00) - 0.00 + 3.00
    assert body["client_id"] == "client-1"
    assert body["idempotent_replay"] is False
    assert "id" in body and "created_at" in body

    # Stock decremented 10 -> 8.
    assert await _stock_qty(client, seed["product_id"], seed["outlet_id"]) == 8

    async with client.session_factory() as session:
        sale = (await session.execute(select(Sale).where(Sale.client_id == "client-1"))).scalar_one()
        line_items = (
            (await session.execute(select(SaleLineItem).where(SaleLineItem.sale_id == sale.id)))
            .scalars()
            .all()
        )
        movements = (
            (await session.execute(select(StockMovement).where(StockMovement.reference_id == sale.id)))
            .scalars()
            .all()
        )

    assert sale.total_amount == Decimal("33.00")
    assert len(line_items) == 1
    assert line_items[0].line_total == Decimal("30.00")
    assert len(movements) == 1
    assert movements[0].delta == -2
    assert movements[0].reason == "sale"
    assert movements[0].client_id == "client-1"


async def test_idempotent_replay_does_not_double_decrement(client):
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-replay")

    first = await client.post("/api/v1/sales", json=payload)
    assert first.status_code == 201
    first_body = first.json()

    second = await client.post("/api/v1/sales", json=payload)
    assert second.status_code == 200
    second_body = second.json()

    assert second_body["idempotent_replay"] is True
    assert second_body["id"] == first_body["id"]
    assert second_body["total_amount"] == first_body["total_amount"]

    # Only decremented once: 10 -> 8, not 10 -> 6.
    assert await _stock_qty(client, seed["product_id"], seed["outlet_id"]) == 8

    async with client.session_factory() as session:
        sales = (
            (await session.execute(select(Sale).where(Sale.client_id == "client-replay")))
            .scalars()
            .all()
        )
    assert len(sales) == 1


async def test_product_not_found(client):
    seed = client.seed
    payload = _sale_payload(seed)
    payload["line_items"][0]["product_id"] = "00000000-0000-0000-0000-000000000000"

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "PRODUCT_NOT_FOUND"
    assert body["error"]["retryable"] is False


async def test_product_from_another_tenant_is_indistinguishable_from_nonexistent(client):
    """Nana's finding: a product that exists but belongs to a different
    admin's catalog must be rejected exactly like a nonexistent product_id —
    same status + code — so cross-tenant probing learns nothing."""
    seed = client.seed
    other_admin_id = uuid.uuid4()
    other_product_id = uuid.uuid4()
    async with client.session_factory() as session:
        session.add(User(id=other_admin_id, role="admin", display_name="Other Admin"))
        session.add(
            Product(
                id=other_product_id,
                admin_id=other_admin_id,
                sku="OTHER-SKU",
                name="Other Widget",
                unit_price=Decimal("9.00"),
            )
        )
        await session.commit()

    cross_tenant_payload = _sale_payload(seed, client_id="client-cross-tenant-product")
    cross_tenant_payload["line_items"][0]["product_id"] = str(other_product_id)

    nonexistent_payload = _sale_payload(seed, client_id="client-nonexistent-product")
    nonexistent_payload["line_items"][0]["product_id"] = "00000000-0000-0000-0000-000000000000"

    cross_tenant_resp = await client.post("/api/v1/sales", json=cross_tenant_payload)
    nonexistent_resp = await client.post("/api/v1/sales", json=nonexistent_payload)

    assert cross_tenant_resp.status_code == nonexistent_resp.status_code == 404
    cross_body, nonexistent_body = cross_tenant_resp.json(), nonexistent_resp.json()
    assert cross_body["error"]["code"] == nonexistent_body["error"]["code"] == "PRODUCT_NOT_FOUND"
    assert cross_body["error"]["retryable"] == nonexistent_body["error"]["retryable"] is False

    # No stock movement/sale row leaked from the rejected cross-tenant line item.
    assert await _stock_qty(client, seed["product_id"], seed["outlet_id"]) == 10


async def test_insufficient_stock_rolls_back_no_partial_rows(client):
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-oversell", quantity=999)

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "INSUFFICIENT_STOCK"
    assert body["error"]["retryable"] is False

    # Stock cache untouched.
    assert await _stock_qty(client, seed["product_id"], seed["outlet_id"]) == 10

    # No partial rows anywhere.
    async with client.session_factory() as session:
        sales = (
            (await session.execute(select(Sale).where(Sale.client_id == "client-oversell")))
            .scalars()
            .all()
        )
        movements = (
            (await session.execute(select(StockMovement).where(StockMovement.client_id == "client-oversell")))
            .scalars()
            .all()
        )
    assert sales == []
    assert movements == []


async def test_rejects_float_money(client):
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-float")
    payload["line_items"][0]["unit_price"] = 15.0  # float, not a string

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_three_decimal_places(client):
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-3dp", unit_price="15.005")

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_empty_line_items(client):
    seed = client.seed
    payload = _sale_payload(seed)
    payload["line_items"] = []

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_non_positive_quantity(client):
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-badqty", quantity=0)

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_missing_client_id(client):
    seed = client.seed
    payload = _sale_payload(seed)
    del payload["client_id"]

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
