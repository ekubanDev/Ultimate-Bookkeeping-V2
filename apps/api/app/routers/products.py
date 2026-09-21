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

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, get_current_user
from app.authz import resolve_authorized_outlet
from app.db import get_db
from app.errors import AppError, format_money
from app.models import Product
from app.rate_limit import READ_RATE_LIMIT, WRITE_RATE_LIMIT, limiter
from app.schemas import ProductCreateRequest, ProductResponse, ProductUpdateRequest

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


def _require_admin(current_user: CurrentUser) -> None:
    """Catalog writes are admin-only.

    Products belong to an admin (products.admin_id), not to an outlet — one
    catalog is shared across every outlet that admin owns, so an outlet
    manager editing a price would silently reprice their colleagues' shops
    too. CLAUDE.md's scope boundary says the same thing from the other
    direction: catalog management is admin territory.

    403, not 404: unlike the cross-tenant case, there is nothing to hide
    here. A manager knows products exist — they sell them all day. Collapsing
    this to 404 would obscure a permission answer without protecting
    anything.
    """
    if current_user.role != "admin":
        raise AppError(
            code="FORBIDDEN",
            message="Only an admin can change the product catalog.",
            retryable=False,
            status_code=status.HTTP_403_FORBIDDEN,
        )


def _to_response(product: Product) -> ProductResponse:
    return ProductResponse(
        id=product.id,
        sku=product.sku,
        name=product.name,
        unit_price=format_money(Decimal(product.unit_price)),
        min_stock=product.min_stock,
    )


@router.post("", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(WRITE_RATE_LIMIT)
async def create_product(
    request: Request,
    payload: ProductCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> ProductResponse:
    _require_admin(current_user)
    outlet = await resolve_authorized_outlet(db, current_user, payload.outlet_id)

    product = Product(
        id=uuid.uuid4(),
        admin_id=outlet.admin_id,
        sku=payload.sku,
        name=payload.name,
        unit_price=payload.unit_price_decimal,
        min_stock=payload.min_stock,
        created_by=current_user.id,
    )
    db.add(product)

    try:
        await db.commit()
    except IntegrityError:
        # uq_products_admin_sku — this tenant already has a product with this
        # SKU. Deliberately NOT an upsert: silently rewriting an existing
        # product's name and price because the SKU matched is how a catalog
        # import quietly changes what the till charges. The caller is told,
        # and PATCHes if replacing the row is what they meant.
        await db.rollback()
        raise AppError(
            code="PRODUCT_SKU_EXISTS",
            message=f"A product with SKU {payload.sku!r} already exists in this catalog.",
            retryable=False,
            status_code=status.HTTP_409_CONFLICT,
        ) from None

    await db.refresh(product)
    return _to_response(product)


@router.patch("/{product_id}", response_model=ProductResponse)
@limiter.limit(WRITE_RATE_LIMIT)
async def update_product(
    request: Request,
    product_id: uuid.UUID,
    payload: ProductUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
) -> ProductResponse:
    _require_admin(current_user)
    outlet = await resolve_authorized_outlet(db, current_user, payload.outlet_id)

    product = await db.get(Product, product_id)
    # Tenant check on the ROW, not just the outlet: a valid admin naming their
    # own outlet must still not be able to edit another tenant's product by id.
    # Same 404-for-both-causes rule as resolve_authorized_outlet, so a missing
    # product and someone else's product are indistinguishable.
    if product is None or product.admin_id != outlet.admin_id:
        raise AppError(
            code="PRODUCT_NOT_FOUND",
            message=f"Product {product_id} not found in this catalog.",
            retryable=False,
            status_code=status.HTTP_404_NOT_FOUND,
        )

    fields = payload.model_dump(exclude_unset=True, exclude={"outlet_id", "unit_price"})
    for key, value in fields.items():
        setattr(product, key, value)
    if payload.unit_price is not None:
        product.unit_price = payload.unit_price_decimal

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AppError(
            code="PRODUCT_SKU_EXISTS",
            message=f"A product with SKU {payload.sku!r} already exists in this catalog.",
            retryable=False,
            status_code=status.HTTP_409_CONFLICT,
        ) from None

    await db.refresh(product)
    return _to_response(product)
