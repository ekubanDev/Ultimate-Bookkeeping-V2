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
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.auth import CurrentUser, get_current_user
from app.db import Base, get_db
from app.main import app
from app.models import Outlet, Product, StockLevel, User

# When set, the whole suite runs against this database instead of an
# in-memory SQLite one — same test code, no duplication. CI sets this to a
# real Postgres (asyncpg) service container so NUMERIC(12,2) precision, the
# partial unique index on stock_movements, enum-as-varchar round-tripping,
# and asyncpg's prepared-statement behaviour are all exercised against the
# database this actually runs on in production, not just aiosqlite. Unset
# locally by default so `pytest` with no setup still Just Works against the
# fast in-memory default.
DATABASE_URL = os.environ.get("DATABASE_URL")


@pytest_asyncio.fixture
async def engine():
    if DATABASE_URL:
        # Real (persistent, shared) database — schema must be created and
        # torn down per test for isolation; unlike the sqlite branch below,
        # this isn't a fresh in-memory instance per engine.
        test_engine = create_async_engine(DATABASE_URL, future=True)
    else:
        test_engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield test_engine
    if DATABASE_URL:
        # NOT `Base.metadata.drop_all` here — this is a real difference
        # Postgres surfaced that SQLite never would (see backend report):
        # `Outlet.admin_id`'s FK (app/models.py) has no explicit
        # constraint name, and outlets<->users is a genuine cycle
        # (outlets.admin_id -> users.id, users.outlet_id -> outlets.id).
        # `create_all` tolerates that (it succeeds, verified separately),
        # but `drop_all`'s cycle-breaking strategy requires a *named*
        # constraint to emit `DROP CONSTRAINT`, and raises
        # `sqlalchemy.exc.CircularDependencyError` without one. Dropping
        # and recreating the schema sidesteps needing any topological sort
        # at all, and is the standard way to reset a real Postgres between
        # tests regardless. Production is unaffected: it never calls
        # `create_all`/`drop_all` — deploys run the hand-corrected Alembic
        # migration, which creates/drops `outlets`/`users` in explicit,
        # cycle-safe order with a named constraint (see alembic/versions/).
        async with test_engine.begin() as conn:
            await conn.execute(text("DROP SCHEMA public CASCADE"))
            await conn.execute(text("CREATE SCHEMA public"))
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
        # Flushed in explicit dependency order rather than one flat
        # session.add(...) x N + commit(). `outlets.admin_id -> users.id`
        # and `users.outlet_id -> outlets.id` are a genuine schema-level
        # cycle (app/models.py); SQLAlchemy has no `relationship()` between
        # User/Outlet here to resolve per-row insert order for a mixed
        # batch, so a single flush's table-level ordering is not
        # guaranteed to insert the admin User before the Outlet that
        # references it. On aiosqlite this was silently fine (FK
        # constraints aren't enforced there by default); against real
        # Postgres it intermittently raised
        # `ForeignKeyViolationError: ... outlets_admin_id_fkey ...
        # is not present in table "users"` — a genuine Postgres-only
        # failure this fixture had, caught by running the suite against
        # Postgres in CI (see backend report). Flushing admin -> outlet ->
        # (manager, product, stock) in that order matches the actual data
        # dependency and is correct on both backends.
        session.add(User(id=admin_id, role="admin", display_name="Admin"))
        await session.flush()

        session.add(Outlet(id=outlet_id, admin_id=admin_id, name="Test Outlet"))
        await session.flush()

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
