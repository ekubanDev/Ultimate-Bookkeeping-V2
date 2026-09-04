"""POST /api/v1/sales — api-contracts.md §2, design.md §3.3-§3.5.

Processing order, matching design.md §3.4:
1. Idempotency check on `sales.client_id` FIRST, before any other validation
   against DB state — a replayed intent should never fail differently than it
   did the first time.
2. Fresh path, single transaction: verify products exist, verify stock
   covers the sale, compute totals, insert sale + line items + stock
   movements, update the stock_levels cache, commit all-or-nothing.
3. Race handled: if two concurrent POSTs for the same client_id both pass the
   pre-check, the UNIQUE constraint on sales.client_id catches the loser at
   commit time; we roll back and return the winner's row instead of erroring.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from starlette.responses import JSONResponse

from app.auth import CurrentUser, get_current_user
from app.authz import resolve_authorized_outlet
from app.db import get_db
from app.errors import AppError, format_money
from app.models import Product, Sale, SaleLineItem, StockLevel, StockMovement
from app.pricing import LineItemInput, compute_sale_totals
from app.schemas import SaleCreateRequest, SaleListItemResponse, SaleResponse

router = APIRouter(prefix="/api/v1/sales", tags=["sales"])


def _sale_line_items_flagged(sale: Sale) -> bool:
    """OR across a (already-loaded) sale's line items' `price_variance_flagged`
    columns. Callers must have eager-loaded `sale.line_items` (selectinload)
    — this never issues a query itself, to keep it safe to call from async
    contexts without triggering an implicit lazy-load."""
    return any(item.price_variance_flagged for item in sale.line_items)


def _sale_to_response(sale: Sale, *, price_variance_flagged: bool, idempotent_replay: bool) -> SaleResponse:
    return SaleResponse(
        id=sale.id,
        client_id=sale.client_id,
        status=sale.status,
        subtotal_amount=format_money(Decimal(sale.subtotal_amount)),
        discount_amount=format_money(Decimal(sale.discount_amount)),
        tax_amount=format_money(Decimal(sale.tax_amount)),
        total_amount=format_money(Decimal(sale.total_amount)),
        price_variance_flagged=price_variance_flagged,
        created_at=sale.created_at,
        idempotent_replay=idempotent_replay,
    )


async def _fetch_by_client_id(db: AsyncSession, client_id: str) -> Sale | None:
    # Eager-load line_items (selectinload) so idempotent-replay responses
    # can compute `price_variance_flagged` without an implicit lazy-load
    # (unsafe/unsupported under AsyncSession outside an explicit await).
    result = await db.execute(
        select(Sale).where(Sale.client_id == client_id).options(selectinload(Sale.line_items))
    )
    return result.scalar_one_or_none()


@router.post("", response_model=SaleResponse, status_code=status.HTTP_201_CREATED)
async def create_sale(
    payload: SaleCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> JSONResponse:
    # --- 1. Idempotency first (design.md §3.4 step 1) ---------------------
    existing = await _fetch_by_client_id(db, payload.client_id)
    if existing is not None:
        body = _sale_to_response(
            existing, price_variance_flagged=_sale_line_items_flagged(existing), idempotent_replay=True
        )
        return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))

    # Resolution note (ambiguity, resolved): api-contracts.md §2 shows
    # `outlet_id` in the request body, but §1 says outlet_id must be
    # "resolved from the users table, never trusted from the request body."
    # We reconcile this by treating the authenticated user's own outlet_id as
    # authoritative for outlet_managers (the body value, if present, is
    # ignored); admins have no fixed outlet_id in `users` and must supply the
    # target outlet explicitly in the body. `resolve_authorized_outlet` also
    # enforces that an admin-supplied outlet_id actually belongs to that
    # admin's tenant (Nana's IDOR finding) — see app/authz.py.
    outlet = await resolve_authorized_outlet(db, current_user, payload.outlet_id)
    outlet_id = outlet.id

    # --- 2. Verify every product exists AND belongs to this outlet's tenant
    # (Nana's finding: existence alone isn't enough — a product from another
    # admin's catalog must be rejected exactly like a nonexistent one, so
    # cross-tenant probing can't tell the two apart. Single query: filter the
    # IN-lookup by admin_id up front, then compare found vs. requested ids,
    # rather than a per-item admin_id round trip.)
    product_ids = [item.product_id for item in payload.line_items]
    products_result = await db.execute(
        select(Product).where(Product.id.in_(product_ids), Product.admin_id == outlet.admin_id)
    )
    products_by_id = {p.id: p for p in products_result.scalars().all()}
    missing = [str(pid) for pid in product_ids if pid not in products_by_id]
    if missing:
        raise AppError(
            code="PRODUCT_NOT_FOUND",
            message=f"Product(s) no longer exist in this outlet's catalog: {', '.join(missing)}",
            retryable=False,
            status_code=404,
        )

    # --- 3. Verify stock covers every line item -----------------------------
    stock_result = await db.execute(
        select(StockLevel).where(StockLevel.outlet_id == outlet_id, StockLevel.product_id.in_(product_ids))
    )
    stock_by_product = {s.product_id: s for s in stock_result.scalars().all()}

    for item in payload.line_items:
        level = stock_by_product.get(item.product_id)
        available = level.quantity if level is not None else 0
        if available < item.quantity:
            raise AppError(
                code="INSUFFICIENT_STOCK",
                message=(
                    f"Insufficient stock for product {item.product_id}: "
                    f"requested {item.quantity}, available {available}"
                ),
                retryable=False,
                status_code=409,
            )

    # --- 4. Compute totals (Decimal only, never float) ----------------------
    # Server-authoritative pricing (Ama's spec): pure computation lives in
    # app/pricing.py, fed with `catalog_unit_price` read from `products`
    # HERE, at transaction-commit time (not intent-creation time) — never
    # the client-supplied price, and never fed back into the money math,
    # only used for the audit snapshot + variance flag.
    line_inputs = [
        LineItemInput(
            quantity=item.quantity,
            unit_price=item.submitted_unit_price_decimal,
            catalog_unit_price=Decimal(products_by_id[item.product_id].unit_price),
        )
        for item in payload.line_items
    ]
    totals = compute_sale_totals(
        line_inputs,
        discount_type=payload.discount_type,
        discount_value=payload.discount_value_decimal,
        tax_amount=payload.tax_amount_decimal,
    )

    # --- 5. Write sale + line items + stock movements + stock cache, one txn
    sale = Sale(
        id=uuid.uuid4(),
        outlet_id=outlet_id,
        client_id=payload.client_id,
        subtotal_amount=totals.subtotal_amount,
        total_amount=totals.total_amount,
        tax_amount=totals.tax_amount,
        discount_type=payload.discount_type,
        discount_value=payload.discount_value_decimal,
        discount_amount=totals.discount_amount,
        payment_method=payload.payment_method,
        status="completed",
        created_by=current_user.id,
        device_recorded_at=payload.device_recorded_at,
    )
    db.add(sale)

    for item, computed_line in zip(payload.line_items, totals.line_items):
        db.add(
            SaleLineItem(
                id=uuid.uuid4(),
                sale_id=sale.id,
                product_id=item.product_id,
                quantity=item.quantity,
                # Persisted verbatim — never replaced by a catalog lookup.
                unit_price=computed_line.unit_price,
                line_total=computed_line.line_total,
                catalog_unit_price_at_sale=computed_line.catalog_unit_price_at_sale,
                price_variance_flagged=computed_line.price_variance_flagged,
            )
        )
        db.add(
            StockMovement(
                id=uuid.uuid4(),
                product_id=item.product_id,
                outlet_id=outlet_id,
                delta=-item.quantity,
                reason="sale",
                reference_id=sale.id,
                client_id=payload.client_id,
                created_by=current_user.id,
            )
        )
        level = stock_by_product.get(item.product_id)
        if level is not None:
            level.quantity -= item.quantity
        else:
            # Shouldn't happen (insufficient-stock check above would have
            # caught a missing row unless quantity requested was 0, which
            # quantity>0 validation already forbids) — defensive only.
            db.add(
                StockLevel(
                    id=uuid.uuid4(),
                    product_id=item.product_id,
                    outlet_id=outlet_id,
                    quantity=-item.quantity,
                )
            )

    try:
        await db.commit()
    except IntegrityError:
        # Race: another request with the same client_id committed first.
        await db.rollback()
        winner = await _fetch_by_client_id(db, payload.client_id)
        if winner is None:
            raise
        body = _sale_to_response(
            winner, price_variance_flagged=_sale_line_items_flagged(winner), idempotent_replay=True
        )
        return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))

    await db.refresh(sale)
    body = _sale_to_response(sale, price_variance_flagged=totals.price_variance_flagged, idempotent_replay=False)
    return JSONResponse(status_code=status.HTTP_201_CREATED, content=body.model_dump(mode="json"))


@router.get("", response_model=list[SaleListItemResponse])
async def list_sales(
    outlet_id: uuid.UUID | None = Query(default=None),
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    # New filter this change adds — the hook a future admin review queue
    # needs (task spec). `None` (default) means "no filter", matching every
    # other optional query param on this endpoint.
    price_variance_flagged: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> list[SaleListItemResponse]:
    """api-contracts.md §2: `GET /api/v1/sales?outlet_id=&from=&to=`,
    paginated, `created_at`-ordered (never `device_recorded_at` — design.md
    §3.5). Outlet scoping mirrors POST /sales / GET /stock/levels via the
    shared `resolve_authorized_outlet` helper.
    """
    resolved_outlet = await resolve_authorized_outlet(db, current_user, outlet_id)
    target_outlet_id = resolved_outlet.id

    query = (
        select(Sale)
        .where(Sale.outlet_id == target_outlet_id)
        .options(selectinload(Sale.line_items))
        .order_by(Sale.created_at)
    )
    if from_ is not None:
        query = query.where(Sale.created_at >= from_)
    if to is not None:
        query = query.where(Sale.created_at <= to)
    if price_variance_flagged is not None:
        flagged_line_exists = (
            select(SaleLineItem.id)
            .where(SaleLineItem.sale_id == Sale.id, SaleLineItem.price_variance_flagged.is_(True))
            .exists()
        )
        query = query.where(flagged_line_exists if price_variance_flagged else ~flagged_line_exists)

    query = query.limit(limit).offset(offset)
    result = await db.execute(query)
    sales = result.scalars().unique().all()

    return [
        SaleListItemResponse(
            id=sale.id,
            client_id=sale.client_id,
            outlet_id=sale.outlet_id,
            status=sale.status,
            payment_method=sale.payment_method,
            subtotal_amount=format_money(Decimal(sale.subtotal_amount)),
            discount_amount=format_money(Decimal(sale.discount_amount)),
            tax_amount=format_money(Decimal(sale.tax_amount)),
            total_amount=format_money(Decimal(sale.total_amount)),
            price_variance_flagged=_sale_line_items_flagged(sale),
            created_at=sale.created_at,
        )
        for sale in sales
    ]
