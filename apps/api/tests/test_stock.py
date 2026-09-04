from __future__ import annotations

import uuid

from sqlalchemy import select

from app.models import Product, StockLevel, StockMovement, User


def _adjustment_payload(seed, *, client_id="adj-1", delta=-3, reason="adjustment"):
    return {
        "client_id": client_id,
        "product_id": str(seed["product_id"]),
        "outlet_id": str(seed["outlet_id"]),
        "delta": delta,
        "reason": reason,
    }


async def _stock_qty(client, product_id, outlet_id) -> int:
    async with client.session_factory() as session:
        result = await session.execute(
            select(StockLevel).where(StockLevel.product_id == product_id, StockLevel.outlet_id == outlet_id)
        )
        level = result.scalar_one_or_none()
        return level.quantity if level is not None else None


async def test_happy_path_adjustment_decrements_stock(client):
    seed = client.seed
    resp = await client.post("/api/v1/stock/adjustments", json=_adjustment_payload(seed))

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "recorded"
    assert body["quantity"] == 7  # 10 - 3
    assert body["client_id"] == "adj-1"
    assert body["idempotent_replay"] is False
    assert "id" in body and "created_at" in body

    assert await _stock_qty(client, seed["product_id"], seed["outlet_id"]) == 7

    async with client.session_factory() as session:
        movements = (
            (await session.execute(select(StockMovement).where(StockMovement.client_id == "adj-1")))
            .scalars()
            .all()
        )
    assert len(movements) == 1
    assert movements[0].delta == -3
    assert movements[0].reason == "adjustment"


async def test_restock_creates_missing_stock_levels_row(client):
    seed = client.seed
    # A brand-new product for this outlet with no stock_levels row yet.
    new_product_id = uuid.uuid4()
    async with client.session_factory() as session:
        session.add(
            Product(
                id=new_product_id,
                admin_id=seed["admin_id"],
                sku="SKU2",
                name="Gadget",
                unit_price="20.00",
            )
        )
        await session.commit()

    payload = _adjustment_payload(seed, client_id="restock-1", delta=15, reason="restock")
    payload["product_id"] = str(new_product_id)

    resp = await client.post("/api/v1/stock/adjustments", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["quantity"] == 15

    assert await _stock_qty(client, new_product_id, seed["outlet_id"]) == 15


async def test_idempotent_replay_does_not_double_apply_delta(client):
    seed = client.seed
    payload = _adjustment_payload(seed, client_id="adj-replay", delta=-2)

    first = await client.post("/api/v1/stock/adjustments", json=payload)
    assert first.status_code == 201
    first_body = first.json()

    second = await client.post("/api/v1/stock/adjustments", json=payload)
    assert second.status_code == 200
    second_body = second.json()

    assert second_body["idempotent_replay"] is True
    assert second_body["id"] == first_body["id"]
    assert second_body["quantity"] == first_body["quantity"] == 8  # 10 - 2, applied once

    assert await _stock_qty(client, seed["product_id"], seed["outlet_id"]) == 8

    async with client.session_factory() as session:
        movements = (
            (await session.execute(select(StockMovement).where(StockMovement.client_id == "adj-replay")))
            .scalars()
            .all()
        )
    assert len(movements) == 1


async def test_adjustment_replay_lookup_does_not_collide_with_sale_movements(client):
    """A sale's stock_movements rows share the sale's client_id. An
    adjustment endpoint lookup must never treat that as its own replay."""
    seed = client.seed
    shared_client_id = "shared-id-1"

    sale_payload = {
        "client_id": shared_client_id,
        "outlet_id": str(seed["outlet_id"]),
        "line_items": [{"product_id": str(seed["product_id"]), "quantity": 1, "submitted_unit_price": "15.00"}],
        "payment_method": "cash",
        "discount_type": "fixed",
        "discount_value": "0.00",
        "tax_amount": "0.00",
        "device_recorded_at": "2026-08-31T18:42:03Z",
    }
    sale_resp = await client.post("/api/v1/sales", json=sale_payload)
    assert sale_resp.status_code == 201

    # Now issue an adjustment with the SAME client_id — it must be treated
    # as a fresh adjustment (fresh insert, 201), not a replay of the sale's
    # movement row.
    adj_resp = await client.post(
        "/api/v1/stock/adjustments", json=_adjustment_payload(seed, client_id=shared_client_id, delta=-1)
    )
    assert adj_resp.status_code == 201, adj_resp.text
    assert adj_resp.json()["idempotent_replay"] is False


async def test_insufficient_stock_rolls_back_no_partial_rows(client):
    seed = client.seed
    payload = _adjustment_payload(seed, client_id="adj-oversell", delta=-999)

    resp = await client.post("/api/v1/stock/adjustments", json=payload)

    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "INSUFFICIENT_STOCK"
    assert body["error"]["retryable"] is False

    # Stock cache untouched.
    assert await _stock_qty(client, seed["product_id"], seed["outlet_id"]) == 10

    async with client.session_factory() as session:
        movements = (
            (await session.execute(select(StockMovement).where(StockMovement.client_id == "adj-oversell")))
            .scalars()
            .all()
        )
    assert movements == []


async def test_product_not_found(client):
    seed = client.seed
    payload = _adjustment_payload(seed, client_id="adj-nf")
    payload["product_id"] = "00000000-0000-0000-0000-000000000000"

    resp = await client.post("/api/v1/stock/adjustments", json=payload)

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
                unit_price="9.00",
            )
        )
        await session.commit()

    cross_tenant_payload = _adjustment_payload(seed, client_id="adj-cross-tenant-product")
    cross_tenant_payload["product_id"] = str(other_product_id)

    nonexistent_payload = _adjustment_payload(seed, client_id="adj-nonexistent-product")
    nonexistent_payload["product_id"] = "00000000-0000-0000-0000-000000000000"

    cross_tenant_resp = await client.post("/api/v1/stock/adjustments", json=cross_tenant_payload)
    nonexistent_resp = await client.post("/api/v1/stock/adjustments", json=nonexistent_payload)

    assert cross_tenant_resp.status_code == nonexistent_resp.status_code == 404
    cross_body, nonexistent_body = cross_tenant_resp.json(), nonexistent_resp.json()
    assert cross_body["error"]["code"] == nonexistent_body["error"]["code"] == "PRODUCT_NOT_FOUND"
    assert cross_body["error"]["retryable"] == nonexistent_body["error"]["retryable"] is False


async def test_rejects_zero_delta(client):
    seed = client.seed
    payload = _adjustment_payload(seed, client_id="adj-zero", delta=0)

    resp = await client.post("/api/v1/stock/adjustments", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_missing_client_id(client):
    seed = client.seed
    payload = _adjustment_payload(seed)
    del payload["client_id"]

    resp = await client.post("/api/v1/stock/adjustments", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_get_stock_levels_returns_cache_contents(client):
    seed = client.seed
    resp = await client.get("/api/v1/stock/levels", params={"outlet_id": str(seed["outlet_id"])})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    row = body[0]
    assert row["product_id"] == str(seed["product_id"])
    assert row["quantity"] == 10
    assert row["sku"] == "SKU1"
    assert row["product_name"] == "Widget"
    assert "updated_at" in row


async def test_get_stock_levels_reflects_adjustments(client):
    seed = client.seed
    await client.post("/api/v1/stock/adjustments", json=_adjustment_payload(seed, client_id="adj-view", delta=4))

    resp = await client.get("/api/v1/stock/levels", params={"outlet_id": str(seed["outlet_id"])})
    assert resp.status_code == 200
    assert resp.json()[0]["quantity"] == 14


async def test_outlet_manager_cannot_read_another_outlets_levels(client):
    """Outlet scoping is enforced from the auth context — an
    outlet_manager's own outlet always wins over a mismatched query param,
    consistent with how POST /sales resolves outlet_id (see routers/sales.py)."""
    seed = client.seed
    other_outlet_id = uuid.uuid4()

    resp = await client.get("/api/v1/stock/levels", params={"outlet_id": str(other_outlet_id)})

    assert resp.status_code == 200
    # The manager's own outlet's data is returned regardless of the
    # (ignored) mismatched query param — never another outlet's data.
    body = resp.json()
    assert len(body) == 1
    assert body[0]["product_id"] == str(seed["product_id"])
