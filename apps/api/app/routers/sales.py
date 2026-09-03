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
from decimal import Decimal

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import JSONResponse

from app.auth import CurrentUser, get_current_user
from app.authz import resolve_authorized_outlet
from app.db import get_db
from app.errors import AppError, format_money
from app.models import Product, Sale, SaleLineItem, StockLevel, StockMovement
from app.schemas import SaleCreateRequest, SaleResponse

router = APIRouter(prefix="/api/v1/sales", tags=["sales"])


def _sale_to_response(sale: Sale, *, idempotent_replay: bool) -> SaleResponse:
    return SaleResponse(
        id=sale.id,
        client_id=sale.client_id,
        status=sale.status,
        total_amount=format_money(Decimal(sale.total_amount)),
        created_at=sale.created_at,
        idempotent_replay=idempotent_replay,
    )


async def _fetch_by_client_id(db: AsyncSession, client_id: str) -> Sale | None:
    result = await db.execute(select(Sale).where(Sale.client_id == client_id))
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
        body = _sale_to_response(existing, idempotent_replay=True)
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
    line_totals: list[Decimal] = [item.quantity * item.unit_price_decimal for item in payload.line_items]
    subtotal = sum(line_totals, Decimal("0.00"))
    total_amount = subtotal - payload.discount_amount_decimal + payload.tax_amount_decimal

    # --- 5. Write sale + line items + stock movements + stock cache, one txn
    sale = Sale(
        id=uuid.uuid4(),
        outlet_id=outlet_id,
        client_id=payload.client_id,
        total_amount=total_amount,
        tax_amount=payload.tax_amount_decimal,
        discount_amount=payload.discount_amount_decimal,
        payment_method=payload.payment_method,
        status="completed",
        created_by=current_user.id,
        device_recorded_at=payload.device_recorded_at,
    )
    db.add(sale)

    for item, line_total in zip(payload.line_items, line_totals):
        db.add(
            SaleLineItem(
                id=uuid.uuid4(),
                sale_id=sale.id,
                product_id=item.product_id,
                quantity=item.quantity,
                unit_price=item.unit_price_decimal,
                line_total=line_total,
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
        body = _sale_to_response(winner, idempotent_replay=True)
        return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))

    await db.refresh(sale)
    body = _sale_to_response(sale, idempotent_replay=False)
    return JSONResponse(status_code=status.HTTP_201_CREATED, content=body.model_dump(mode="json"))
