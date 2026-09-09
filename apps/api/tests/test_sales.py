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
        # Explicit flush between User and Product: without it, on Postgres
        # this Product insert can be emitted before the User insert it
        # depends on (products.admin_id -> users.id), even though there's
        # no cycle in this particular pair — the unresolvable outlets<->
        # users cycle elsewhere in app/models.py's metadata appears to
        # affect flush-ordering reliability for the whole graph, not just
        # the two cyclic tables. Invisible on aiosqlite (FKs unenforced by
        # default there); a real, reproducible `ForeignKeyViolationError`
        # on Postgres — see backend report.
        session.add(User(id=other_admin_id, role="admin", display_name="Other Admin"))
        await session.flush()
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


# --- GET /api/v1/sales ordering: default desc, order=asc, stable pagination
# under tied `created_at` (Kwame's doc-pass finding) --------------------------

from datetime import datetime, timedelta, timezone  # noqa: E402


async def _insert_sale_directly(
    client,
    seed,
    *,
    client_id: str,
    created_at: datetime,
) -> uuid.UUID:
    """Insert a `sales` row directly (bypassing POST /sales), so `created_at`
    can be pinned to an exact, possibly-shared, value — the server normally
    assigns this at commit time (design.md §3.5), which POST never lets a
    caller control, but that's exactly the thing under test here: whether
    listing is stable when several sales share a `created_at` (very
    plausible when an offline queue flushes a batch on reconnect).
    """
    sale_id = uuid.uuid4()
    async with client.session_factory() as session:
        session.add(
            Sale(
                id=sale_id,
                outlet_id=seed["outlet_id"],
                client_id=client_id,
                subtotal_amount=Decimal("15.00"),
                total_amount=Decimal("15.00"),
                tax_amount=Decimal("0.00"),
                discount_type="fixed",
                discount_value=Decimal("0.00"),
                discount_amount=Decimal("0.00"),
                payment_method="cash",
                status="completed",
                created_by=seed["manager_id"],
                created_at=created_at,
            )
        )
        await session.commit()
    return sale_id


async def test_get_sales_default_order_is_descending_newest_first(client):
    seed = client.seed
    base = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    await _insert_sale_directly(client, seed, client_id="order-oldest", created_at=base)
    await _insert_sale_directly(client, seed, client_id="order-middle", created_at=base + timedelta(minutes=1))
    await _insert_sale_directly(client, seed, client_id="order-newest", created_at=base + timedelta(minutes=2))

    resp = await client.get("/api/v1/sales", params={"outlet_id": str(seed["outlet_id"])})

    assert resp.status_code == 200, resp.text
    assert [row["client_id"] for row in resp.json()] == ["order-newest", "order-middle", "order-oldest"]


async def test_get_sales_order_asc_param_is_chronological(client):
    seed = client.seed
    base = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    await _insert_sale_directly(client, seed, client_id="order-oldest", created_at=base)
    await _insert_sale_directly(client, seed, client_id="order-middle", created_at=base + timedelta(minutes=1))
    await _insert_sale_directly(client, seed, client_id="order-newest", created_at=base + timedelta(minutes=2))

    resp = await client.get("/api/v1/sales", params={"outlet_id": str(seed["outlet_id"]), "order": "asc"})

    assert resp.status_code == 200, resp.text
    assert [row["client_id"] for row in resp.json()] == ["order-oldest", "order-middle", "order-newest"]


async def test_get_sales_invalid_order_param_is_422(client):
    seed = client.seed
    resp = await client.get("/api/v1/sales", params={"outlet_id": str(seed["outlet_id"]), "order": "sideways"})

    assert resp.status_code == 422, resp.text


async def test_get_sales_pagination_stable_across_tied_created_at_desc(client):
    """The important one: several sales sharing the exact same `created_at`
    (plausible when an offline queue flushes a batch on reconnect) must
    still page deterministically — every row exactly once, no duplicates,
    no omissions — under the default `order=desc` with a small `limit`.
    Without the `Sale.id` tiebreaker, an unstable sort could reorder tied
    rows between the two page fetches below and drop or duplicate one.
    """
    seed = client.seed
    tied_at = datetime(2026, 2, 1, 9, 30, 0, tzinfo=timezone.utc)
    client_ids = [f"tied-{i}" for i in range(7)]
    for cid in client_ids:
        await _insert_sale_directly(client, seed, client_id=cid, created_at=tied_at)

    seen: list[str] = []
    offset = 0
    limit = 3
    for _ in range(10):  # generous upper bound on the number of pages needed
        resp = await client.get(
            "/api/v1/sales",
            params={"outlet_id": str(seed["outlet_id"]), "limit": limit, "offset": offset},
        )
        assert resp.status_code == 200, resp.text
        page = [row["client_id"] for row in resp.json()]
        if not page:
            break
        seen.extend(page)
        offset += limit

    assert sorted(seen) == sorted(client_ids)
    assert len(seen) == len(client_ids)  # no duplicates
    assert len(set(seen)) == len(client_ids)  # no duplicates, alternate check


async def test_get_sales_pagination_stable_across_tied_created_at_asc(client):
    """Same as above, mirrored for `order=asc` — the tiebreaker must apply
    (in matching direction) on both sort directions, not just the default.
    """
    seed = client.seed
    tied_at = datetime(2026, 2, 1, 9, 30, 0, tzinfo=timezone.utc)
    client_ids = [f"tied-asc-{i}" for i in range(7)]
    for cid in client_ids:
        await _insert_sale_directly(client, seed, client_id=cid, created_at=tied_at)

    seen: list[str] = []
    offset = 0
    limit = 3
    for _ in range(10):
        resp = await client.get(
            "/api/v1/sales",
            params={"outlet_id": str(seed["outlet_id"]), "order": "asc", "limit": limit, "offset": offset},
        )
        assert resp.status_code == 200, resp.text
        page = [row["client_id"] for row in resp.json()]
        if not page:
            break
        seen.extend(page)
        offset += limit

    assert sorted(seen) == sorted(client_ids)
    assert len(seen) == len(client_ids)
    assert len(set(seen)) == len(client_ids)


# --- GET /api/v1/sales tenant/outlet scoping (Adjoa's QA finding — mirrors
# test_outlet_manager_cannot_read_another_outlets_levels in tests/test_stock.py
# and test_outlet_manager_is_scoped_to_own_outlet_ignoring_query_param in
# tests/test_products.py; admin cross-tenant/404-parity coverage for this
# endpoint lives in tests/test_authz.py) -------------------------------------


async def test_outlet_manager_cannot_read_another_outlets_sales(client):
    """Outlet scoping is enforced from the auth context — an
    outlet_manager's own outlet always wins over a mismatched query param on
    GET /sales too, consistent with every other endpoint through
    `resolve_authorized_outlet`."""
    seed = client.seed
    other_outlet_id = uuid.uuid4()
    create_resp = await client.post(
        "/api/v1/sales", json=_sale_payload(seed, client_id="own-outlet-sale")
    )
    assert create_resp.status_code == 201, create_resp.text

    resp = await client.get("/api/v1/sales", params={"outlet_id": str(other_outlet_id)})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["client_id"] == "own-outlet-sale"
    assert body[0]["outlet_id"] == str(seed["outlet_id"])


async def _insert_sale_with_flag_directly(
    client, seed, *, client_id: str, created_at: datetime, price_variance_flagged: bool
) -> uuid.UUID:
    """Like `_insert_sale_directly` above, but also inserts one
    `SaleLineItem` so `price_variance_flagged` (an OR across a sale's line
    items — see routers/sales.py `_sale_line_items_flagged`) can be pinned
    directly, and `created_at` can be pinned independent of wall-clock POST
    order — both matter here since two real POSTs made back-to-back in this
    (fast, in-memory) test setup aren't guaranteed to land in different
    `created_at` ticks, which would make the expected order/filter results
    below flaky rather than deterministic."""
    sale_id = await _insert_sale_directly(client, seed, client_id=client_id, created_at=created_at)
    async with client.session_factory() as session:
        session.add(
            SaleLineItem(
                id=uuid.uuid4(),
                sale_id=sale_id,
                product_id=seed["product_id"],
                quantity=1,
                unit_price=Decimal("15.00"),
                line_total=Decimal("15.00"),
                catalog_unit_price_at_sale=Decimal("15.00"),
                price_variance_flagged=price_variance_flagged,
            )
        )
        await session.commit()
    return sale_id


async def test_outlet_manager_scoping_holds_with_price_variance_filter_and_order(client):
    """Combines the own-outlet-always-wins guarantee above with the
    `price_variance_flagged` filter and `order` param, per task spec: a
    filter or sort must never widen what a caller can see. A
    malicious/foreign `outlet_id` param, together with every filter/order
    combination, must still only ever return this outlet_manager's own
    outlet's sales."""
    seed = client.seed
    other_outlet_id = uuid.uuid4()
    base = datetime(2026, 3, 1, 9, 0, 0, tzinfo=timezone.utc)

    await _insert_sale_with_flag_directly(
        client, seed, client_id="scope-clean", created_at=base, price_variance_flagged=False
    )
    await _insert_sale_with_flag_directly(
        client,
        seed,
        client_id="scope-flagged",
        created_at=base + timedelta(minutes=1),
        price_variance_flagged=True,
    )

    for flagged_param, order_param, expected_client_ids in (
        (None, "desc", ["scope-flagged", "scope-clean"]),
        (None, "asc", ["scope-clean", "scope-flagged"]),
        (True, "desc", ["scope-flagged"]),
        (False, "desc", ["scope-clean"]),
    ):
        params = {"outlet_id": str(other_outlet_id), "order": order_param}
        if flagged_param is not None:
            params["price_variance_flagged"] = str(flagged_param).lower()

        resp = await client.get("/api/v1/sales", params=params)

        assert resp.status_code == 200, (flagged_param, order_param, resp.text)
        body = resp.json()
        assert [row["client_id"] for row in body] == expected_client_ids, (flagged_param, order_param)
        assert all(row["outlet_id"] == str(seed["outlet_id"]) for row in body)


# --- Upper bounds on quantity / line-item count (Adjoa's QA finding) --------
#
# `SaleLineItemIn.quantity` previously had no `le=`, and
# `SaleCreateRequest.line_items` had no `max_length` — see app/schemas.py for
# the chosen bounds (MAX_QUANTITY_PER_LINE_ITEM=10_000,
# MAX_LINE_ITEMS_PER_SALE=100) and the reasoning behind them. A total near
# the NUMERIC(12,2) ceiling is exercised against real Postgres specifically
# (test_sale_near_numeric_12_2_ceiling_round_trips_on_real_db, below) — this
# is exactly the kind of DB-boundary behaviour SQLite (no NUMERIC precision
# enforcement) would silently pass regardless of whether it actually works.


async def test_rejects_quantity_above_ceiling(client):
    seed = client.seed
    payload = _sale_payload(seed, client_id="client-qty-ceiling")
    payload["line_items"][0]["quantity"] = 10_001  # MAX_QUANTITY_PER_LINE_ITEM + 1

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_accepts_quantity_at_ceiling(client):
    """Guard against over-tightening: exactly MAX_QUANTITY_PER_LINE_ITEM is
    still valid. Uses a dedicated product stocked to exactly the ceiling —
    the default seeded stock (10 units) would otherwise fail on
    INSUFFICIENT_STOCK before quantity validation is even the thing under
    test."""
    seed = client.seed
    product_id = await _add_product(client, seed, unit_price=Decimal("0.01"), quantity=10_000)
    payload = _sale_payload(
        seed, client_id="client-qty-at-ceiling", unit_price="0.01", product_id=product_id
    )
    payload["line_items"][0]["quantity"] = 10_000  # MAX_QUANTITY_PER_LINE_ITEM

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text


async def test_rejects_line_items_above_ceiling(client):
    seed = client.seed
    # 101 line items for the same product (MAX_LINE_ITEMS_PER_SALE=100 + 1)
    # — content doesn't matter, only the count; rejected by Pydantic's
    # `max_length` before any DB/catalog lookup happens.
    payload = _sale_payload(seed, client_id="client-lineitems-ceiling")
    payload["line_items"] = [
        {"product_id": str(seed["product_id"]), "quantity": 1, "submitted_unit_price": "15.00"}
        for _ in range(101)
    ]

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 422, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_sale_near_numeric_12_2_ceiling_round_trips_on_real_db(client):
    """DB-boundary check (task spec): a total near the NUMERIC(12,2) ceiling
    (max 9,999,999,999.99 — 10 integer digits, 2dp) must be accepted,
    persisted, and read back exactly — this is precisely the kind of
    assertion that passes on SQLite (no NUMERIC precision enforcement)
    whether or not it's actually true, and must be verified against real
    Postgres. Run via `DATABASE_URL=...postgresql...` per tests/conftest.py.

    A single line item (quantity=1) at the ceiling price is used rather than
    a large quantity, since MAX_QUANTITY_PER_LINE_ITEM (10_000) x a
    realistic catalog price stays nowhere near this boundary by design (see
    app/schemas.py) — this test is about the DB column's own limit, not
    about triggering it via the new quantity ceiling.
    """
    seed = client.seed
    ceiling_price = "9999999999.99"  # NUMERIC(12,2) max: 10 integer digits + 2dp
    product_id = await _add_product(client, seed, unit_price=Decimal(ceiling_price), quantity=1)

    payload = _sale_payload(
        seed,
        client_id="client-numeric-ceiling",
        quantity=1,
        unit_price=ceiling_price,
        tax="0.00",
        discount_value="0.00",
        product_id=product_id,
    )

    resp = await client.post("/api/v1/sales", json=payload)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["subtotal_amount"] == ceiling_price
    assert body["total_amount"] == ceiling_price

    list_resp = await client.get("/api/v1/sales", params={"outlet_id": str(seed["outlet_id"])})
    assert list_resp.status_code == 200, list_resp.text
    listed = next(row for row in list_resp.json() if row["client_id"] == "client-numeric-ceiling")
    assert listed["total_amount"] == ceiling_price
