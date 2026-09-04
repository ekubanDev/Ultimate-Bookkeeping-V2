"""GET /api/v1/products — task spec: happy path, tenant scoping (identical
to how routers/sales.py and routers/stock.py enforce it, via the shared
app.authz.resolve_authorized_outlet), outlet_manager scoped to own outlet,
empty catalog returns []."""
from __future__ import annotations

import uuid
from decimal import Decimal

from app.models import Outlet, Product, User


async def test_happy_path_lists_products_ordered_by_name(client):
    seed = client.seed
    # Add a second product so ordering is actually exercised (name < "Widget").
    async with client.session_factory() as session:
        session.add(
            Product(
                id=uuid.uuid4(),
                admin_id=seed["admin_id"],
                sku="SKU0",
                name="Apple",
                unit_price=Decimal("3.50"),
                min_stock=5,
            )
        )
        await session.commit()

    resp = await client.get("/api/v1/products", params={"outlet_id": str(seed["outlet_id"])})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [p["name"] for p in body] == ["Apple", "Widget"]

    widget = next(p for p in body if p["name"] == "Widget")
    assert widget["id"] == str(seed["product_id"])
    assert widget["sku"] == "SKU1"
    assert widget["unit_price"] == "15.00"
    assert widget["min_stock"] == 1

    apple = next(p for p in body if p["name"] == "Apple")
    assert apple["sku"] == "SKU0"
    assert apple["unit_price"] == "3.50"
    assert apple["min_stock"] == 5


async def test_empty_catalog_returns_empty_list(client):
    seed = client.seed
    # Delete the seeded product so this tenant's catalog is empty.
    async with client.session_factory() as session:
        from sqlalchemy import delete

        await session.execute(delete(Product).where(Product.id == seed["product_id"]))
        await session.commit()

    resp = await client.get("/api/v1/products", params={"outlet_id": str(seed["outlet_id"])})

    assert resp.status_code == 200, resp.text
    assert resp.json() == []


async def test_outlet_manager_is_scoped_to_own_outlet_ignoring_query_param(client):
    """Mirrors test_outlet_manager_cannot_read_another_outlets_levels in
    tests/test_stock.py — an outlet_manager's own outlet always wins over
    a mismatched query param."""
    seed = client.seed
    other_outlet_id = uuid.uuid4()

    resp = await client.get("/api/v1/products", params={"outlet_id": str(other_outlet_id)})

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == str(seed["product_id"])


async def test_admin_cannot_list_another_tenants_products(admin_client):
    """Tenant scoping (task spec): an admin of tenant A can't list tenant
    B's products — identical 404 to a nonexistent outlet (Nana's IDOR
    finding, same convention as tests/test_authz.py)."""
    other_admin_id = uuid.uuid4()
    other_outlet_id = uuid.uuid4()
    async with admin_client.session_factory() as session:
        session.add(User(id=other_admin_id, role="admin", display_name="Other Admin"))
        session.add(Outlet(id=other_outlet_id, admin_id=other_admin_id, name="Other Outlet"))
        session.add(
            Product(
                id=uuid.uuid4(),
                admin_id=other_admin_id,
                sku="OTHER-SKU",
                name="Other Widget",
                unit_price=Decimal("9.00"),
            )
        )
        await session.commit()

    cross_tenant_resp = await admin_client.get(
        "/api/v1/products", params={"outlet_id": str(other_outlet_id)}
    )
    nonexistent_resp = await admin_client.get(
        "/api/v1/products", params={"outlet_id": str(uuid.uuid4())}
    )

    assert cross_tenant_resp.status_code == nonexistent_resp.status_code == 404
    cross_body, nonexistent_body = cross_tenant_resp.json(), nonexistent_resp.json()
    assert cross_body["error"]["code"] == nonexistent_body["error"]["code"] == "OUTLET_NOT_FOUND"
    assert cross_body["error"]["retryable"] == nonexistent_body["error"]["retryable"] is False
    assert cross_body == nonexistent_body


async def test_admin_happy_path_lists_own_outlets_products(admin_client):
    seed = admin_client.seed

    resp = await admin_client.get("/api/v1/products", params={"outlet_id": str(seed["outlet_id"])})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == str(seed["product_id"])
