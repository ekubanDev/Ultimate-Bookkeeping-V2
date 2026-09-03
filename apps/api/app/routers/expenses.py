"""POST /api/v1/expenses — api-contracts.md §4, design.md §2.8, §3.3-§3.5.

Follows the `sales` append-only-ledger template exactly (design.md §2.8),
so this router mirrors routers/sales.py's processing order:
1. Idempotency check on `expenses.client_id` FIRST.
2. Fresh path: insert the expense row, commit.
3. Race handled: the UNIQUE constraint on expenses.client_id catches a
   concurrent duplicate at commit time; roll back and return the winner's
   row instead of erroring.

No product involvement, so there's no PRODUCT_NOT_FOUND/INSUFFICIENT_STOCK
path here — only VALIDATION_ERROR (money format, missing fields),
OUTLET_NOT_FOUND (unresolvable or cross-tenant outlet_id, via
app.authz.resolve_authorized_outlet), and the idempotency/race handling
shared with sales.
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
from app.errors import format_money
from app.models import Expense
from app.schemas import ExpenseCreateRequest, ExpenseResponse

router = APIRouter(prefix="/api/v1/expenses", tags=["expenses"])


def _expense_to_response(expense: Expense, *, idempotent_replay: bool) -> ExpenseResponse:
    return ExpenseResponse(
        id=expense.id,
        client_id=expense.client_id,
        status=expense.status,
        amount=format_money(Decimal(expense.amount)),
        created_at=expense.created_at,
        idempotent_replay=idempotent_replay,
    )


async def _fetch_by_client_id(db: AsyncSession, client_id: str) -> Expense | None:
    result = await db.execute(select(Expense).where(Expense.client_id == client_id))
    return result.scalar_one_or_none()


@router.post("", response_model=ExpenseResponse, status_code=status.HTTP_201_CREATED)
async def create_expense(
    payload: ExpenseCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> JSONResponse:
    # --- 1. Idempotency first (design.md §3.4 step 1) ---------------------
    existing = await _fetch_by_client_id(db, payload.client_id)
    if existing is not None:
        body = _expense_to_response(existing, idempotent_replay=True)
        return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))

    # Same outlet_id resolution as routers/sales.py, now via the shared
    # resolve_authorized_outlet helper — enforces that an admin-supplied
    # outlet_id actually belongs to that admin's tenant (Nana's IDOR
    # finding; see app/authz.py).
    outlet = await resolve_authorized_outlet(db, current_user, payload.outlet_id)
    outlet_id = outlet.id

    # --- 2. Write expense, one txn ------------------------------------------
    expense = Expense(
        id=uuid.uuid4(),
        outlet_id=outlet_id,
        client_id=payload.client_id,
        amount=payload.amount_decimal,
        category=payload.category,
        note=payload.note,
        status="recorded",
        created_by=current_user.id,
        device_recorded_at=payload.device_recorded_at,
    )
    db.add(expense)

    try:
        await db.commit()
    except IntegrityError:
        # Race: another request with the same client_id committed first.
        await db.rollback()
        winner = await _fetch_by_client_id(db, payload.client_id)
        if winner is None:
            raise
        body = _expense_to_response(winner, idempotent_replay=True)
        return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))

    await db.refresh(expense)
    body = _expense_to_response(expense, idempotent_replay=False)
    return JSONResponse(status_code=status.HTTP_201_CREATED, content=body.model_dump(mode="json"))
