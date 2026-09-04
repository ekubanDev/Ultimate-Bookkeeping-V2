"""GET /api/v1/me.

Not yet in ultimate-bookkeeping-v2-api-contracts.md — this needs to be added
there with Kwame/Ama sign-off; not done here per the task's instruction that
contract-doc edits are theirs to make. Kojo is building the outlet app's
outlet_id bootstrap against exactly this response shape in parallel, so treat
it as frozen (see app/schemas.py:MeResponse for the one caveat found while
implementing: `display_name` is nullable in the `users` table).

This is the only way the outlet app learns its own `outlet_id` — it is never
accepted from the client for outlet_manager users (app/auth.py,
api-contracts.md §1), so the client has to ask the server.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, get_current_user
from app.db import get_db
from app.models import User
from app.rate_limit import AUTH_RATE_LIMIT, limiter
from app.schemas import MeResponse

router = APIRouter(prefix="/api/v1", tags=["me"])


@router.get("/me", response_model=MeResponse)
@limiter.limit(AUTH_RATE_LIMIT)
async def get_me(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> MeResponse:
    # get_current_user already proved this row exists (that's how
    # CurrentUser got built) but CurrentUser doesn't carry display_name —
    # widening it for one endpoint's sake isn't worth it, so re-fetch here.
    user = (await db.execute(select(User).where(User.id == current_user.id))).scalar_one()
    return MeResponse(
        id=user.id,
        role=user.role,
        outlet_id=user.outlet_id,
        display_name=user.display_name,
    )
