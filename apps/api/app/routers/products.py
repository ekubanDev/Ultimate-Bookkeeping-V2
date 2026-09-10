"""GET /api/v1/products — online-only read, frozen contract (task spec):

    GET /api/v1/products?outlet_id=<uuid> -> 200
    [{"id": "uuid", "sku": "SKU-001", "name": "Milo 400g",
      "unit_price": "15.00", "min_stock": 10}]

Replaces the outlet app's hardcoded DEMO_PRODUCTS catalog (PosScreen) — Kojo
builds against this exact shape. Not yet in api-contracts.md; flagged for
Kwame/Ama to add (not edited here — see app/routers/me.py for the identical
convention on the other undocumented-but-frozen endpoint).

Tenant scoping + pagination conventions deliberately mirror GET
/api/v1/sales (app/routers/sales.py) and GET /api/v1/stock/levels
(app/routers/stock.py):
- outlet resolution + authorization goes through the shared
  `resolve_authorized_outlet` (app/authz.py) — an outlet_manager's own
  outlet always wins, an admin must own the requested outlet, and a
  nonexistent outlet is indistinguishable from a cross-tenant one (same 404
  OUTLET_NOT_FOUND, no leak — Nana's IDOR finding).
- Catalog scoping (`products.admin_id == outlet.admin_id`) is the same
  tenant boundary already enforced ad hoc in routers/sales.py and
  routers/stock.py's product-lookup checks.
- `limit`/`offset` share GET /sales's exact defaults/caps (default 50,
  1-200) for consistency across list endpoints — task spec.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, get_current_user
from app.authz import resolve_authorized_outlet
from app.db import get_db
from app.errors import format_money
from app.models import Product
from app.rate_limit import READ_RATE_LIMIT, limiter
from app.schemas import ProductResponse

router = APIRouter(prefix="/api/v1/products", tags=["products"])


@router.get("", response_model=list[ProductResponse])
@limiter.limit(READ_RATE_LIMIT)
async def list_products(
    request: Request,
    outlet_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> list[ProductResponse]:
    resolved_outlet = await resolve_authorized_outlet(db, current_user, outlet_id)

    query = (
        select(Product)
        .where(Product.admin_id == resolved_outlet.admin_id)
        .order_by(Product.name)
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(query)
    products = result.scalars().all()

    return [
        ProductResponse(
            id=product.id,
            sku=product.sku,
            name=product.name,
            unit_price=format_money(Decimal(product.unit_price)),
            min_stock=product.min_stock,
        )
        for product in products
    ]
