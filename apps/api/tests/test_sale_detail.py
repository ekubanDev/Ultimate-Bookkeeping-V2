"""GET /api/v1/sales/{id} — one sale, with the catalog price it was measured against.

Built for the price-variance review, which is a gate on the pilot: someone
looks at flagged sales daily for the first weeks.

Before this endpoint, `catalog_unit_price_at_sale` was written on every line
since pricing became server-authoritative and exposed by nothing. The list
endpoint could say a sale was flagged; no endpoint could say what the
variance WAS. A review queue that reports "something was wrong here" without
saying what is not a review queue, and that gap would have been discovered
by whoever sat down to do the first daily review.

The tenant tests matter as much as the variance ones: a sale detail carries
what a business charged and what its catalog said, which is precisely the
information a competitor would want.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from app.models import Outlet, Product, Sale, SaleLineItem, User


async def _sale_with_variance(client, *, submitted: str, catalog: str, quantity: int = 1):
    """A committed sale whose line was charged at `submitted` while the
    catalog held `catalog`."""
    sale_id, product_id = uuid.uuid4(), client.seed["product_id"]
    async with client.session_factory() as session:
        session.add(
            Sale(
                id=sale_id,
                outlet_id=client.seed["outlet_id"],
                client_id=f"detail-{sale_id}",
                subtotal_amount=Decimal(submitted) * quantity,
                discount_amount=Decimal("0.00"),
                tax_amount=Decimal("0.00"),
                total_amount=Decimal(submitted) * quantity,
                payment_method="cash",
            )
        )
        await session.flush()
        session.add(
            SaleLineItem(
                id=uuid.uuid4(),
                sale_id=sale_id,
                product_id=product_id,
                quantity=quantity,
                unit_price=Decimal(submitted),
                line_total=Decimal(submitted) * quantity,
                catalog_unit_price_at_sale=Decimal(catalog),
                price_variance_flagged=abs(Decimal(submitted) - Decimal(catalog))
                > max(Decimal(catalog) * Decimal("0.02"), Decimal("0.50")),
            )
        )
        await session.commit()
    return sale_id


async def test_returns_the_sale_with_its_line_items(client):
    sale_id = await _sale_with_variance(client, submitted="15.00", catalog="15.00")

    resp = await client.get(f"/api/v1/sales/{sale_id}")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == str(sale_id)
    assert len(body["line_items"]) == 1


async def test_exposes_both_prices_so_a_variance_can_be_read(client):
    """The pair is the point — neither number means anything alone."""
    sale_id = await _sale_with_variance(client, submitted="5.00", catalog="15.00")

    line = (await client.get(f"/api/v1/sales/{sale_id}")).json()["line_items"][0]

    assert line["unit_price"] == "5.00", "what the till actually charged"
    assert line["catalog_unit_price_at_sale"] == "15.00", "what the catalog said at the time"
    assert line["price_variance_flagged"] is True


async def test_a_sale_within_tolerance_is_not_flagged(client):
    """2% or GHS 0.50, whichever is greater (app/pricing.py) — ordinary
    rounding on a cheap item must not cry wolf, or the daily review becomes
    noise someone stops reading."""
    sale_id = await _sale_with_variance(client, submitted="15.40", catalog="15.00")

    body = (await client.get(f"/api/v1/sales/{sale_id}")).json()

    assert body["price_variance_flagged"] is False
    assert body["line_items"][0]["price_variance_flagged"] is False


async def test_the_sale_level_flag_is_an_or_across_its_lines(client):
    sale_id = await _sale_with_variance(client, submitted="1.00", catalog="15.00")

    assert (await client.get(f"/api/v1/sales/{sale_id}")).json()["price_variance_flagged"] is True


async def test_money_is_a_string_everywhere(client):
    """CLAUDE.md: money is a string over the wire, never a float."""
    sale_id = await _sale_with_variance(client, submitted="27.50", catalog="27.50", quantity=3)

    body = (await client.get(f"/api/v1/sales/{sale_id}")).json()
    line = body["line_items"][0]

    for value in (body["total_amount"], body["subtotal_amount"],
                  line["unit_price"], line["line_total"], line["catalog_unit_price_at_sale"]):
        assert isinstance(value, str) and value.count(".") == 1
    assert line["line_total"] == "82.50"


async def test_includes_the_product_name_so_the_reviewer_can_find_it(client):
    sale_id = await _sale_with_variance(client, submitted="5.00", catalog="15.00")

    line = (await client.get(f"/api/v1/sales/{sale_id}")).json()["line_items"][0]

    assert line["product_name"], "a reviewer needs a name, not only a uuid"
    assert "product_id" in line


async def test_a_nonexistent_sale_is_404(client):
    resp = await client.get(f"/api/v1/sales/{uuid.uuid4()}")

    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "SALE_NOT_FOUND"


async def test_another_tenants_sale_is_indistinguishable_from_a_missing_one(client):
    """A sale detail carries what a business charged and what its catalog
    said. Leaking it across a tenant boundary — or even confirming the id
    exists — is exactly what the 404-for-both rule prevents elsewhere."""
    other_admin, other_outlet, other_sale = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with client.session_factory() as session:
        session.add(User(id=other_admin, role="admin", display_name="Other Admin"))
        await session.flush()
        session.add(Outlet(id=other_outlet, admin_id=other_admin, name="Other Outlet"))
        await session.flush()
        session.add(
            Sale(
                id=other_sale,
                outlet_id=other_outlet,
                client_id=f"other-{other_sale}",
                subtotal_amount=Decimal("999.00"),
                discount_amount=Decimal("0.00"),
                tax_amount=Decimal("0.00"),
                total_amount=Decimal("999.00"),
                payment_method="cash",
            )
        )
        await session.commit()

    resp = await client.get(f"/api/v1/sales/{other_sale}")

    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "SALE_NOT_FOUND"
    assert "999.00" not in resp.text, "another tenant's total leaked"
