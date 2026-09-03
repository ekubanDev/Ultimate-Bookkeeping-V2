"""POST /api/v1/stock/adjustments, GET /api/v1/stock/levels — api-contracts.md
§3, design.md §2.4-§2.5, §3.3-§3.5.

`POST /adjustments` follows the exact processing order of `POST /sales`
(routers/sales.py):
1. Idempotency check on `stock_movements.client_id` FIRST (scoped to
   `reason != 'sale'` — see the long comment on `StockMovement` in
   models.py for why a plain client_id lookup isn't safe here).
2. Fresh path, single transaction: verify the product exists, fetch (or
   note the absence of) the stock_levels row, reject a delta that would
   take quantity negative, insert the movement + upsert the cache, commit
   all-or-nothing.
3. Race handled: if two concurrent POSTs for the same client_id both pass
   the pre-check, the partial unique index on stock_movements.client_id
   catches the loser at commit time; we roll back and return the winner's
   row instead of erroring.

`GET /levels` is a plain online read straight from the stock_levels cache
table (never a live aggregate over stock_movements), per api-contracts.md
§3. Outlet scoping mirrors the resolved ambiguity documented in
routers/sales.py: an outlet_manager's own outlet_id (from the auth context)
is always authoritative and the `outlet_id` query param is ignored for
them; only admins may pass `outlet_id` explicitly, and it's required for
admins since they have no fixed outlet_id in `users`.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import JSONResponse

from app.auth import CurrentUser, get_current_user
from app.authz import resolve_authorized_outlet
from app.db import get_db
from app.errors import AppError
from app.models import Product, StockLevel, StockMovement
from app.schemas import StockAdjustmentRequest, StockAdjustmentResponse, StockLevelResponse

router = APIRouter(prefix="/api/v1/stock", tags=["stock"])


def _movement_to_response(
    movement: StockMovement, *, quantity: int, idempotent_replay: bool
) -> StockAdjustmentResponse:
    return StockAdjustmentResponse(
        id=movement.id,
        client_id=movement.client_id,
        status="recorded",
        quantity=quantity,
        created_at=movement.created_at,
        idempotent_replay=idempotent_replay,
    )


async def _fetch_movement_by_client_id(db: AsyncSession, client_id: str) -> StockMovement | None:
    # Scoped to reason != 'sale' — see StockMovement's docstring in
    # models.py: sale-driven rows share the *sale's* client_id and must
    # never be mistaken for an adjustment/restock replay.
    result = await db.execute(
        select(StockMovement).where(
            StockMovement.client_id == client_id,
            StockMovement.reason != "sale",
        )
    )
    return result.scalar_one_or_none()


async def _fetch_level(db: AsyncSession, product_id: uuid.UUID, outlet_id: uuid.UUID) -> StockLevel | None:
    result = await db.execute(
        select(StockLevel).where(StockLevel.product_id == product_id, StockLevel.outlet_id == outlet_id)
    )
    return result.scalar_one_or_none()


@router.post("/adjustments", response_model=StockAdjustmentResponse, status_code=status.HTTP_201_CREATED)
async def create_stock_adjustment(
    payload: StockAdjustmentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> JSONResponse:
    # --- 1. Idempotency first (design.md §3.4 step 1) ---------------------
    existing = await _fetch_movement_by_client_id(db, payload.client_id)
    if existing is not None:
        level = await _fetch_level(db, existing.product_id, existing.outlet_id)
        body = _movement_to_response(
            existing, quantity=level.quantity if level is not None else 0, idempotent_replay=True
        )
        return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))

    # Same outlet_id resolution as routers/sales.py, now via the shared
    # resolve_authorized_outlet helper — enforces that an admin-supplied
    # outlet_id actually belongs to that admin's tenant (Nana's IDOR
    # finding; see app/authz.py).
    outlet = await resolve_authorized_outlet(db, current_user, payload.outlet_id)
    outlet_id = outlet.id

    # --- 2. Verify the product exists AND belongs to this outlet's tenant --
    # (Nana's finding — see the matching comment in routers/sales.py. A
    # product from another admin's catalog is rejected identically to a
    # nonexistent one.)
    product = await db.get(Product, payload.product_id)
    if product is None or product.admin_id != outlet.admin_id:
        raise AppError(
            code="PRODUCT_NOT_FOUND",
            message=f"Product {payload.product_id} no longer exists in this outlet's catalog.",
            retryable=False,
            status_code=404,
        )

    # --- 3. Compute resulting quantity, reject negative-going deltas -------
    level = await _fetch_level(db, payload.product_id, outlet_id)
    current_quantity = level.quantity if level is not None else 0
    new_quantity = current_quantity + payload.delta
    if new_quantity < 0:
        raise AppError(
            code="INSUFFICIENT_STOCK",
            message=(
                f"Adjustment would take stock below zero for product {payload.product_id}: "
                f"current {current_quantity}, delta {payload.delta}"
            ),
            retryable=False,
            status_code=409,
        )

    # --- 4. Write movement + stock cache, one txn ---------------------------
    movement = StockMovement(
        id=uuid.uuid4(),
        product_id=payload.product_id,
        outlet_id=outlet_id,
        delta=payload.delta,
        reason=payload.reason,
        reference_id=None,
        client_id=payload.client_id,
        created_by=current_user.id,
    )
    db.add(movement)

    if level is not None:
        level.quantity = new_quantity
    else:
        level = StockLevel(
            id=uuid.uuid4(),
            product_id=payload.product_id,
            outlet_id=outlet_id,
            quantity=new_quantity,
        )
        db.add(level)

    try:
        await db.commit()
    except IntegrityError:
        # Race: another request with the same client_id committed first.
        await db.rollback()
        winner = await _fetch_movement_by_client_id(db, payload.client_id)
        if winner is None:
            raise
        winner_level = await _fetch_level(db, winner.product_id, winner.outlet_id)
        body = _movement_to_response(
            winner,
            quantity=winner_level.quantity if winner_level is not None else 0,
            idempotent_replay=True,
        )
        return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))

    await db.refresh(movement)
    await db.refresh(level)
    body = _movement_to_response(movement, quantity=level.quantity, idempotent_replay=False)
    return JSONResponse(status_code=status.HTTP_201_CREATED, content=body.model_dump(mode="json"))


@router.get("/levels", response_model=list[StockLevelResponse])
async def get_stock_levels(
    outlet_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> list[StockLevelResponse]:
    # Outlet scoping enforced from the auth context, not the query param
    # alone (task spec) — same resolution as POST /sales and POST
    # /stock/adjustments, now via the shared resolve_authorized_outlet
    # helper: an outlet_manager's own outlet_id always wins, and an
    # admin-supplied outlet_id must belong to that admin's tenant (Nana's
    # IDOR finding; see app/authz.py). Nonexistent and another tenant's
    # outlet_id both surface as the same 404 OUTLET_NOT_FOUND.
    resolved_outlet = await resolve_authorized_outlet(db, current_user, outlet_id)
    target_outlet_id = resolved_outlet.id

    result = await db.execute(
        select(StockLevel, Product)
        .join(Product, Product.id == StockLevel.product_id)
        .where(StockLevel.outlet_id == target_outlet_id)
        .order_by(Product.name)
    )
    rows = result.all()
    return [
        StockLevelResponse(
            product_id=level.product_id,
            product_name=product.name,
            sku=product.sku,
            quantity=level.quantity,
            updated_at=level.updated_at,
        )
        for level, product in rows
    ]
