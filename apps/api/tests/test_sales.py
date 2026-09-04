from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import select

from app.models import Product, Sale, SaleLineItem, StockLevel, StockMovement, User


def _sale_payload(
    seed,
    *,
    client_id="client-1",
    quantity=2,
    unit_price="15.00",
    tax="3.00",
    discount_type="fixed",
    discount_value="0.00",
    product_id=None,
):
    return {
        "client_id": client_id,
        "outlet_id": str(seed["outlet_id"]),
        "line_items": [
            {
                "product_id": str(product_id or seed["product_id"]),
                "quantity": quantity,
                "submitted_unit_price": unit_price,
            }
        ],
        "payment_method": "mobile_money",
        "discount_type": discount_type,
        "discount_value": discount_value,
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


async def _add_product(client, seed, *, unit_price: Decimal, quantity: int = 10) -> uuid.UUID:
    """Seed an extra catalog product (+ stock) beyond the default one in
    `seed`, for tests that need a specific catalog price."""
    product_id = uuid.uuid4()
    async with client.session_factory() as session:
        session.add(
            Product(
                id=product_id,
                admin_id=seed["admin_id"],
                sku=f"SKU-{product_id}",
                name="Extra Widget",
                unit_price=unit_price,
            )
        )
        session.add(
            StockLevel(id=uuid.uuid4(), product_id=product_id, outlet_id=seed["outlet_id"], quantity=quantity)
        )
        await session.commit()
    return product_id


async def test_happy_path_creates_sale_and_decrements_stock(client):
    seed = client.seed
    resp = await client.post("/api/v1/sales", json=_sale_payload(seed))

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "completed"
    assert body["subtotal_amount"] == "30.00"  # 2 * 15.00
    assert body["discount_amount"] == "0.00"
    assert body["tax_amount"] == "3.00"
    assert body["total_amount"] == "33.00"  # 30.00 - 0.00 + 3.00
    assert body["price_variance_flagged"] is False  # submitted price matches catalog exactly
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

    assert sale.subtotal_amount == Decimal("30.00")
    assert sale.discount_amount == Decimal("0.00")
    assert sale.total_amount == Decimal("33.00")
    assert len(line_items) == 1
    assert line_items[0].unit_price == Decimal("15.00")
    assert line_items[0].line_total == Decimal("30.00")
    assert line_items[0].catalog_unit_price_at_sale == Decimal("15.00")
    assert line_items[0].price_variance_flagged is False
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
    assert second_body["subtotal_amount"] == first_body["subtotal_amount"]
    assert second_body["discount_amount"] == first_body["discount_amount"]
    assert second_body["price_variance_flagged"] == first_body["price_variance_flagged"]

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
    payload["line_items"][0]["submitted_unit_price"] = 15.0  # float, not a string

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


# --- Server-authoritative pricing (Ama's spec / Nana's skimming finding) ---


async def test_percentage_discount_rounds_once_not_per_line(client):
    """Two line items whose per-line discount would each round .005 up
    individually (10.05 * 10% = 1.005 -> 1.01 each, summing to 2.02), but
    the spec requires rounding ONCE on the summed subtotal (20.10 * 10% =
    2.010 -> 2.01) — these two approaches must diverge here, proving the
    implementation rounds once, not per line."""
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-round-once", discount_type="percentage", discount_value="0.00")
    payload["discount_type"] = "percentage"
    payload["discount_value"] = "10.00"
    payload["tax_amount"] = "0.00"
    payload["line_items"] = [
        {"product_id": str(seed["product_id"]), "quantity": 1, "submitted_unit_price": "10.05"},
        {"product_id": str(seed["product_id"]), "quantity": 1, "submitted_unit_price": "10.05"},
    ]

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["subtotal_amount"] == "20.10"
    assert body["discount_amount"] == "2.01"  # NOT 2.02 (the per-line-rounded sum)
    assert body["total_amount"] == "18.09"  # NOT 18.08


async def test_percentage_discount_round_half_up_on_exact_boundary(client):
    """150.00 * 0.75% = 1.125 exactly — the digit before the terminal 5 is
    '2' (even), so ROUND_HALF_EVEN would give 1.12 while ROUND_HALF_UP (the
    spec) gives 1.13. Proves HALF_UP specifically, not banker's rounding."""
    seed = client.seed
    payload = _sale_payload(
        seed,
        client_id="client-half-up-boundary",
        quantity=10,
        unit_price="15.00",  # matches catalog exactly -> no variance noise
        discount_type="percentage",
        discount_value="0.75",
        tax="0.00",
    )

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["subtotal_amount"] == "150.00"
    assert body["discount_amount"] == "1.13"  # ROUND_HALF_UP(1.125), not 1.12
    assert body["total_amount"] == "148.87"


async def test_percentage_discount_outside_range_rejected(client):
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-pct-oor", discount_type="percentage", discount_value="100.01")

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_fixed_discount_clamped_to_subtotal(client):
    """A fixed discount larger than the subtotal clamps to the subtotal —
    discount never exceeds what's being discounted, and total is never
    negative (here it equals tax, since discount fully absorbs subtotal)."""
    seed = client.seed
    payload = _sale_payload(
        seed,
        client_id="client-fixed-clamp",
        quantity=1,
        unit_price="15.00",
        discount_type="fixed",
        discount_value="999.00",
        tax="3.00",
    )

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["subtotal_amount"] == "15.00"
    assert body["discount_amount"] == "15.00"  # clamped to subtotal, not 999.00
    assert body["total_amount"] == "3.00"  # == tax_amount exactly


async def test_total_amount_floored_at_zero(client):
    seed = client.seed
    payload = _sale_payload(
        seed,
        client_id="client-floor-zero",
        quantity=1,
        unit_price="15.00",
        discount_type="fixed",
        discount_value="999.00",
        tax="0.00",
    )

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["total_amount"] == "0.00"


async def test_client_supplied_totals_are_ignored(client):
    """The server never trusts client-supplied subtotal/discount/total —
    even if the client sends garbage values in the body, the response
    always reflects server computation."""
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-ignore-totals", quantity=2, unit_price="15.00", tax="3.00")
    payload["subtotal_amount"] = "1.00"
    payload["discount_amount"] = "1.00"
    payload["total_amount"] = "1.00"

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["subtotal_amount"] == "30.00"
    assert body["discount_amount"] == "0.00"
    assert body["total_amount"] == "33.00"


async def test_unit_price_persisted_verbatim_even_when_it_differs_from_catalog(client):
    """A completed, paid transaction is never repriced after the fact —
    unit_price is stored exactly as submitted, catalog price only recorded
    alongside for audit."""
    seed = client.seed
    payload = _sale_payload(
        seed, client_id="client-verbatim-price", quantity=1, unit_price="20.00"  # catalog is 15.00
    )

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["price_variance_flagged"] is True

    async with client.session_factory() as session:
        sale = (await session.execute(select(Sale).where(Sale.client_id == "client-verbatim-price"))).scalar_one()
        line_item = (
            await session.execute(select(SaleLineItem).where(SaleLineItem.sale_id == sale.id))
        ).scalar_one()

    assert line_item.unit_price == Decimal("20.00")  # verbatim, never replaced by catalog lookup
    assert line_item.catalog_unit_price_at_sale == Decimal("15.00")
    assert line_item.price_variance_flagged is True
    assert line_item.line_total == Decimal("20.00")


async def test_price_variance_not_flagged_within_cheap_item_floor(client):
    """GHS 3.00 catalog item, GHS 0.06 variance: 2% of 3.00 is 0.06, but the
    flat GHS 0.50 floor applies (max(0.06, 0.50) == 0.50), so 0.06 is well
    inside tolerance and must NOT be flagged."""
    seed = client.seed
    product_id = await _add_product(client, seed, unit_price=Decimal("3.00"))
    payload = _sale_payload(
        seed, client_id="client-cheap-no-flag", quantity=1, unit_price="3.06", product_id=product_id
    )

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    assert resp.json()["price_variance_flagged"] is False


async def test_price_variance_flagged_above_expensive_item_two_percent_and_sale_still_commits(client):
    """GHS 300.00 catalog item, GHS 10.00 variance: 2% of 300.00 is 6.00
    (greater than the 0.50 floor), and 10.00 > 6.00, so this MUST be
    flagged — but flagging never blocks: the sale still commits (201) and
    stock still decrements."""
    seed = client.seed
    product_id = await _add_product(client, seed, unit_price=Decimal("300.00"), quantity=5)
    payload = _sale_payload(
        seed, client_id="client-expensive-flag", quantity=1, unit_price="310.00", product_id=product_id
    )

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["price_variance_flagged"] is True

    # Flagging never blocks/delays/alters the sale — stock still decremented.
    assert await _stock_qty(client, product_id, seed["outlet_id"]) == 4

    async with client.session_factory() as session:
        sale = (await session.execute(select(Sale).where(Sale.client_id == "client-expensive-flag"))).scalar_one()
        line_item = (
            await session.execute(select(SaleLineItem).where(SaleLineItem.sale_id == sale.id))
        ).scalar_one()
    assert line_item.price_variance_flagged is True


# --- GET /api/v1/sales price_variance_flagged filter (admin review queue hook) ---


async def test_get_sales_price_variance_flagged_filter(client):
    seed = client.seed
    clean_payload = _sale_payload(seed, client_id="client-list-clean", quantity=1, unit_price="15.00")
    flagged_product_id = await _add_product(client, seed, unit_price=Decimal("300.00"))
    flagged_payload = _sale_payload(
        seed, client_id="client-list-flagged", quantity=1, unit_price="310.00", product_id=flagged_product_id
    )

    assert (await client.post("/api/v1/sales", json=clean_payload)).status_code == 201
    assert (await client.post("/api/v1/sales", json=flagged_payload)).status_code == 201

    all_resp = await client.get("/api/v1/sales", params={"outlet_id": str(seed["outlet_id"])})
    assert all_resp.status_code == 200, all_resp.text
    assert {row["client_id"] for row in all_resp.json()} == {"client-list-clean", "client-list-flagged"}

    flagged_resp = await client.get(
        "/api/v1/sales", params={"outlet_id": str(seed["outlet_id"]), "price_variance_flagged": "true"}
    )
    assert flagged_resp.status_code == 200, flagged_resp.text
    flagged_body = flagged_resp.json()
    assert [row["client_id"] for row in flagged_body] == ["client-list-flagged"]
    assert flagged_body[0]["price_variance_flagged"] is True

    unflagged_resp = await client.get(
        "/api/v1/sales", params={"outlet_id": str(seed["outlet_id"]), "price_variance_flagged": "false"}
    )
    assert unflagged_resp.status_code == 200, unflagged_resp.text
    unflagged_body = unflagged_resp.json()
    assert [row["client_id"] for row in unflagged_body] == ["client-list-clean"]
    assert unflagged_body[0]["price_variance_flagged"] is False
