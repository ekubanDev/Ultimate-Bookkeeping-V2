"""POST/PATCH /api/v1/products — the catalog write path.

Until this existed there was NO supported way to create a product: the
router was GET-only, no code anywhere constructed a Product, and the outlet
app has no catalog screen. The only routes in were seed_dev.py's fixed demo
catalog or raw SQL against production — which is how a pilot outlet's real
prices could not be loaded at all.

Admin-only, deliberately. Products belong to an admin
(products.admin_id), not to an outlet: one catalog is shared by every outlet
that admin owns, so a manager editing a price would silently reprice their
colleagues' shops too.

The tenant tests here are the load-bearing ones. `unit_price` is what the
POS charges AND what price_variance_flagged is measured against
(app/pricing.py), so a write reaching the wrong tenant's catalog changes
what another business sells things for.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import select

from app.models import Outlet, Product, User


async def _other_tenant(client) -> dict:
    """A second admin + outlet + product, unrelated to `seed`'s tenant."""
    ids = {"admin_id": uuid.uuid4(), "outlet_id": uuid.uuid4(), "product_id": uuid.uuid4()}
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
        await session.commit()
    return ids


def _body(seed, **over) -> dict:
    payload = {
        "outlet_id": str(seed["outlet_id"]),
        "name": "Milo 400g Tin",
        "unit_price": "45.00",
        "sku": "MILO-400G-NEW",
        "min_stock": 20,
    }
    payload.update(over)
    return payload


# --- create ---------------------------------------------------------------


async def test_admin_creates_a_product(admin_client):
    resp = await admin_client.post("/api/v1/products", json=_body(admin_client.seed))

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Milo 400g Tin"
    assert body["unit_price"] == "45.00"
    assert body["sku"] == "MILO-400G-NEW"
    assert body["min_stock"] == 20


async def test_created_product_records_who_made_it(admin_client):
    """Attribution is the reason created_by was added to this table — 'who
    changed this price' had no answer before."""
    resp = await admin_client.post("/api/v1/products", json=_body(admin_client.seed))
    product_id = uuid.UUID(resp.json()["id"])

    async with admin_client.session_factory() as session:
        product = await session.get(Product, product_id)
        assert product.created_by == admin_client.seed["admin_id"]
        assert product.created_at is not None
        assert product.updated_at is not None


async def test_a_product_in_the_catalog_is_visible_to_the_outlet_manager(client):
    """The whole point: a product added to the catalog must appear in the POS.

    Seeded directly rather than via admin_client, because `client` and
    `admin_client` both override the SAME get_current_user dependency key
    (tests/conftest.py) — requesting both in one test silently gives you one
    identity for both, not two. Worth knowing before writing any other
    two-role test.
    """
    async with client.session_factory() as session:
        session.add(
            Product(
                id=uuid.uuid4(),
                admin_id=client.seed["admin_id"],
                sku="MILO-400G-NEW",
                name="Milo 400g Tin",
                unit_price=Decimal("45.00"),
                min_stock=20,
            )
        )
        await session.commit()

    listed = await client.get(f"/api/v1/products?outlet_id={client.seed['outlet_id']}")
    assert listed.status_code == 200, listed.text
    assert any(p["sku"] == "MILO-400G-NEW" for p in listed.json())


async def test_outlet_manager_cannot_create_a_product(client):
    """One catalog is shared across an admin's outlets — a manager editing it
    would reprice shops that are not theirs."""
    resp = await client.post("/api/v1/products", json=_body(client.seed))

    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "FORBIDDEN"


async def test_duplicate_sku_is_refused_not_silently_upserted(admin_client):
    """Rewriting an existing product because the SKU matched is how a catalog
    import quietly changes what the till charges."""
    first = await admin_client.post("/api/v1/products", json=_body(admin_client.seed))
    assert first.status_code == 201

    second = await admin_client.post(
        "/api/v1/products", json=_body(admin_client.seed, name="Something Else", unit_price="99.00")
    )
    assert second.status_code == 409, second.text
    assert second.json()["error"]["code"] == "PRODUCT_SKU_EXISTS"

    # The original is untouched.
    async with admin_client.session_factory() as session:
        rows = (
            await session.execute(select(Product).where(Product.sku == "MILO-400G-NEW"))
        ).scalars().all()
    assert len(rows) == 1
    assert rows[0].name == "Milo 400g Tin"
    assert rows[0].unit_price == Decimal("45.00")


async def test_two_products_without_a_sku_are_both_allowed(admin_client):
    """Unbarcoded items are not duplicates of each other — the unique index is
    partial on `sku IS NOT NULL` for this reason."""
    a = await admin_client.post("/api/v1/products", json=_body(admin_client.seed, sku=None, name="Loose sweets"))
    b = await admin_client.post("/api/v1/products", json=_body(admin_client.seed, sku=None, name="Loose nuts"))

    assert a.status_code == 201, a.text
    assert b.status_code == 201, b.text


async def test_admin_cannot_create_a_product_in_another_tenants_outlet(admin_client):
    other = await _other_tenant(admin_client)

    resp = await admin_client.post(
        "/api/v1/products", json=_body(admin_client.seed, outlet_id=str(other["outlet_id"]))
    )

    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "OUTLET_NOT_FOUND"


# --- money validation -----------------------------------------------------


async def test_rejects_a_price_that_is_not_numeric_2dp(admin_client):
    resp = await admin_client.post("/api/v1/products", json=_body(admin_client.seed, unit_price="45.999"))
    assert resp.status_code == 422, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_a_float_price(admin_client):
    """Money is a string over the wire (CLAUDE.md) — a JSON number is not."""
    resp = await admin_client.post("/api/v1/products", json=_body(admin_client.seed, unit_price=45.00))
    assert resp.status_code == 422, resp.text


async def test_rejects_a_price_beyond_the_numeric_ceiling(admin_client):
    resp = await admin_client.post(
        "/api/v1/products", json=_body(admin_client.seed, unit_price="99999999999.00")
    )
    assert resp.status_code == 422, resp.text


# --- update ---------------------------------------------------------------


async def test_admin_updates_a_price(admin_client):
    created = await admin_client.post("/api/v1/products", json=_body(admin_client.seed))
    product_id = created.json()["id"]

    resp = await admin_client.patch(
        f"/api/v1/products/{product_id}",
        json={"outlet_id": str(admin_client.seed["outlet_id"]), "unit_price": "48.50"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["unit_price"] == "48.50"
    assert resp.json()["name"] == "Milo 400g Tin", "a partial update must not blank other fields"


async def test_partial_update_leaves_unmentioned_fields_alone(admin_client):
    created = await admin_client.post("/api/v1/products", json=_body(admin_client.seed))
    product_id = created.json()["id"]

    resp = await admin_client.patch(
        f"/api/v1/products/{product_id}",
        json={"outlet_id": str(admin_client.seed["outlet_id"]), "name": "Milo 400g (refill)"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Milo 400g (refill)"
    assert resp.json()["unit_price"] == "45.00"
    assert resp.json()["min_stock"] == 20


async def test_outlet_manager_cannot_update_a_product(client):
    # Seeded directly — see the note on fixture identity above.
    product_id = uuid.uuid4()
    async with client.session_factory() as session:
        session.add(
            Product(
                id=product_id,
                admin_id=client.seed["admin_id"],
                sku="PATCH-ME",
                name="Milo 400g Tin",
                unit_price=Decimal("45.00"),
            )
        )
        await session.commit()

    resp = await client.patch(
        f"/api/v1/products/{product_id}",
        json={"outlet_id": str(client.seed["outlet_id"]), "unit_price": "1.00"},
    )

    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "FORBIDDEN"


async def test_admin_cannot_update_another_tenants_product_by_id(admin_client):
    """Naming your OWN outlet while targeting someone else's product id must
    not work — the row is checked, not just the outlet."""
    other = await _other_tenant(admin_client)

    resp = await admin_client.patch(
        f"/api/v1/products/{other['product_id']}",
        json={"outlet_id": str(admin_client.seed["outlet_id"]), "unit_price": "0.01"},
    )

    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "PRODUCT_NOT_FOUND"

    async with admin_client.session_factory() as session:
        untouched = await session.get(Product, other["product_id"])
        assert untouched.unit_price == Decimal("9.00"), "another tenant's price was modified"


async def test_updating_a_nonexistent_product_is_the_same_404(admin_client):
    resp = await admin_client.patch(
        f"/api/v1/products/{uuid.uuid4()}",
        json={"outlet_id": str(admin_client.seed["outlet_id"]), "unit_price": "1.00"},
    )
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "PRODUCT_NOT_FOUND"


async def test_update_to_a_taken_sku_is_refused(admin_client):
    await admin_client.post("/api/v1/products", json=_body(admin_client.seed, sku="SKU-A", name="A"))
    second = await admin_client.post("/api/v1/products", json=_body(admin_client.seed, sku="SKU-B", name="B"))

    resp = await admin_client.patch(
        f"/api/v1/products/{second.json()['id']}",
        json={"outlet_id": str(admin_client.seed["outlet_id"]), "sku": "SKU-A"},
    )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PRODUCT_SKU_EXISTS"
