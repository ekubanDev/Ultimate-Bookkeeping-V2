from __future__ import annotations

import os

# Must be set BEFORE `app.main` (and therefore `app.rate_limit`) is first
# imported anywhere in the test session — the limiter reads this exactly
# once, at import time (see app/rate_limit.py). This is the env-flag bypass
# the task spec calls for: the whole suite runs with the limiter disabled by
# default so none of the existing 67 tests (or anything else) gets
# throttled; tests/test_rate_limit.py flips `limiter.enabled` back on for
# just its own duration to exercise the real 429 behavior.
os.environ.setdefault("RATE_LIMIT_ENABLED", "false")

import uuid
from decimal import Decimal

import pytest_asyncio
from fastapi import Request
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.auth import CurrentUser, get_current_user
from app.db import Base, get_db
from app.main import app
from app.models import Outlet, Product, StockLevel, User


@pytest_asyncio.fixture
async def engine():
    test_engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield test_engine
    await test_engine.dispose()


@pytest_asyncio.fixture
async def session_factory(engine):
    return async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)


@pytest_asyncio.fixture
async def seed(session_factory):
    """Minimal admin / outlet / outlet_manager / product / stock fixture set."""
    admin_id = uuid.uuid4()
    outlet_id = uuid.uuid4()
    manager_id = uuid.uuid4()
    product_id = uuid.uuid4()

    async with session_factory() as session:
        session.add(User(id=admin_id, role="admin", display_name="Admin"))
        session.add(Outlet(id=outlet_id, admin_id=admin_id, name="Test Outlet"))
        session.add(
            User(
                id=manager_id,
                role="outlet_manager",
                outlet_id=outlet_id,
                created_by=admin_id,
                display_name="Manager",
            )
        )
        session.add(
            Product(
                id=product_id,
                admin_id=admin_id,
                sku="SKU1",
                name="Widget",
                unit_price=Decimal("15.00"),
                min_stock=1,
            )
        )
        session.add(
            StockLevel(id=uuid.uuid4(), product_id=product_id, outlet_id=outlet_id, quantity=10)
        )
        await session.commit()

    return {
        "admin_id": admin_id,
        "outlet_id": outlet_id,
        "manager_id": manager_id,
        "product_id": product_id,
    }


@pytest_asyncio.fixture
async def client(session_factory, seed):
    async def override_get_db():
        async with session_factory() as session:
            yield session

    async def override_get_current_user(request: Request):
        # Mirrors the `request.state.actor_id` side effect the real
        # `get_current_user` (app/auth.py) performs, for app/rate_limit.py's
        # per-user keying — this override bypasses the real function
        # entirely (no DB/Firebase round trip), so it has to set that state
        # itself or every overridden test client would silently fall back to
        # IP-keyed rate limiting instead of the production per-user keying.
        request.state.actor_id = str(seed["manager_id"])
        return CurrentUser(id=seed["manager_id"], role="outlet_manager", outlet_id=seed["outlet_id"])

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac.seed = seed  # type: ignore[attr-defined]
        ac.session_factory = session_factory  # type: ignore[attr-defined]
        yield ac

    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def admin_client(session_factory, seed):
    """Like `client`, but authenticated as the seed tenant's admin (owns
    seed["outlet_id"] / seed["product_id"]) rather than the outlet_manager —
    needed for admin-specific tenant-boundary tests (see tests/test_authz.py).
    """

    async def override_get_db():
        async with session_factory() as session:
            yield session

    async def override_get_current_user(request: Request):
        # See `client`'s override above for why this sets actor_id itself.
        request.state.actor_id = str(seed["admin_id"])
        return CurrentUser(id=seed["admin_id"], role="admin", outlet_id=None)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac.seed = seed  # type: ignore[attr-defined]
        ac.session_factory = session_factory  # type: ignore[attr-defined]
        yield ac

    app.dependency_overrides.clear()
