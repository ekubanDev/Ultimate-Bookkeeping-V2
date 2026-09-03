"""Tenant-boundary tests for app/authz.py's `resolve_authorized_outlet`, per
Nana's security review: an admin is a per-tenant business owner
(outlets.admin_id/products.admin_id), never a superuser with implicit
access to every outlet in the system.

Uses `admin_client` (tests/conftest.py) — authenticated as the seed
tenant's admin, who owns `seed["outlet_id"]`/`seed["product_id"]` — plus a
second, unrelated tenant created ad hoc per test via `_create_other_tenant`.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from app.models import Outlet, Product, User


async def _create_other_tenant(client):
    """A second admin + outlet + product, entirely unrelated to `seed`'s
    tenant — stands in for "another business" in the same system.
    """
    other_admin_id = uuid.uuid4()
    other_outlet_id = uuid.uuid4()
    other_product_id = uuid.uuid4()
    async with client.session_factory() as session:
        session.add(User(id=other_admin_id, role="admin", display_name="Other Admin"))
        session.add(Outlet(id=other_outlet_id, admin_id=other_admin_id, name="Other Outlet"))
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
    return {"admin_id": other_admin_id, "outlet_id": other_outlet_id, "product_id": other_product_id}


# --- Read path: GET /stock/levels ------------------------------------------


async def test_admin_cannot_read_another_tenants_stock_levels(admin_client):
    other = await _create_other_tenant(admin_client)

    resp = await admin_client.get("/api/v1/stock/levels", params={"outlet_id": str(other["outlet_id"])})

    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "OUTLET_NOT_FOUND"
    assert body["error"]["retryable"] is False


async def test_admin_targeting_nonexistent_outlet_gets_same_404_as_cross_tenant(admin_client):
    """A nonexistent outlet_id and another tenant's real outlet_id must be
    indistinguishable — otherwise an admin could enumerate other tenants'
    outlet_ids by noticing when the response differs (Nana's finding)."""
    other = await _create_other_tenant(admin_client)
    nonexistent_outlet_id = uuid.uuid4()

    cross_tenant_resp = await admin_client.get(
        "/api/v1/stock/levels", params={"outlet_id": str(other["outlet_id"])}
    )
    nonexistent_resp = await admin_client.get(
        "/api/v1/stock/levels", params={"outlet_id": str(nonexistent_outlet_id)}
    )

    assert cross_tenant_resp.status_code == nonexistent_resp.status_code == 404
    assert cross_tenant_resp.json() == nonexistent_resp.json()
    assert cross_tenant_resp.json()["error"]["code"] == "OUTLET_NOT_FOUND"


async def test_admin_happy_path_reads_own_outlet_levels(admin_client):
    """Guard against over-tightening: an admin must still be able to read
    their own outlet's stock levels."""
    seed = admin_client.seed

    resp = await admin_client.get("/api/v1/stock/levels", params={"outlet_id": str(seed["outlet_id"])})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["product_id"] == str(seed["product_id"])


# --- Write paths -------------------------------------------------------------


async def test_admin_cannot_write_another_tenants_stock_adjustment(admin_client):
    other = await _create_other_tenant(admin_client)

    resp = await admin_client.post(
        "/api/v1/stock/adjustments",
        json={
            "client_id": "cross-tenant-adj",
            "product_id": str(other["product_id"]),
            "outlet_id": str(other["outlet_id"]),
            "delta": 5,
            "reason": "restock",
        },
    )

    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "OUTLET_NOT_FOUND"
    assert body["error"]["retryable"] is False


async def test_admin_happy_path_writes_own_outlet_adjustment(admin_client):
    """Guard against over-tightening: an admin must still be able to write
    to their own outlet."""
    seed = admin_client.seed

    resp = await admin_client.post(
        "/api/v1/stock/adjustments",
        json={
            "client_id": "own-outlet-adj",
            "product_id": str(seed["product_id"]),
            "outlet_id": str(seed["outlet_id"]),
            "delta": 5,
            "reason": "restock",
        },
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["quantity"] == 15  # 10 + 5


async def test_admin_cannot_write_another_tenants_sale(admin_client):
    """Smoke assertion on POST /sales, per task spec."""
    other = await _create_other_tenant(admin_client)

    resp = await admin_client.post(
        "/api/v1/sales",
        json={
            "client_id": "cross-tenant-sale",
            "outlet_id": str(other["outlet_id"]),
            "line_items": [{"product_id": str(other["product_id"]), "quantity": 1, "unit_price": "9.00"}],
            "payment_method": "cash",
            "discount_amount": "0.00",
            "tax_amount": "0.00",
        },
    )

    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "OUTLET_NOT_FOUND"
    assert body["error"]["retryable"] is False


async def test_admin_cannot_write_another_tenants_expense(admin_client):
    """Smoke assertion on POST /expenses, per task spec."""
    other = await _create_other_tenant(admin_client)

    resp = await admin_client.post(
        "/api/v1/expenses",
        json={
            "client_id": "cross-tenant-exp",
            "outlet_id": str(other["outlet_id"]),
            "amount": "10.00",
            "category": "utilities",
        },
    )

    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "OUTLET_NOT_FOUND"
    assert body["error"]["retryable"] is False


async def test_outlet_manager_with_dangling_outlet_id_gets_outlet_not_found(session_factory, seed):
    """`resolve_authorized_outlet` also covers the outlet_manager path where
    the outlet row isn't otherwise guaranteed to exist (task spec) — here
    modeled by a manager whose `outlet_id` points at a row that no longer
    exists (e.g. deleted out from under a stale/cached session)."""
    from app.auth import CurrentUser, get_current_user
    from app.db import get_db
    from app.main import app

    dangling_outlet_id = uuid.uuid4()
    manager_id = uuid.uuid4()
    async with session_factory() as session:
        session.add(
            User(
                id=manager_id,
                role="outlet_manager",
                outlet_id=dangling_outlet_id,
                display_name="Orphaned Manager",
            )
        )
        await session.commit()

    async def override_get_db():
        async with session_factory() as session:
            yield session

    async def override_get_current_user():
        return CurrentUser(id=manager_id, role="outlet_manager", outlet_id=dangling_outlet_id)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/v1/stock/levels")

    app.dependency_overrides.clear()

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "OUTLET_NOT_FOUND"
