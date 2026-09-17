"""Async engine/session setup.

DATABASE_URL is read from the environment. In production this points at
Postgres (asyncpg driver). Tests override `get_db` with an in-memory SQLite
(aiosqlite) engine — see tests/conftest.py.

CLOUD SQL (Cloud Run deployment): when `CLOUD_SQL_CONNECTION_NAME` is set,
the connection goes over the Unix socket Cloud Run mounts at
/cloudsql/<connection name> rather than TCP. The socket path is passed via
`connect_args` instead of being embedded in DATABASE_URL as a `?host=`
query parameter: SQLAlchemy's asyncpg dialect does not reliably forward
that parameter through to asyncpg's connect(), and the failure mode is a
confusing "connection refused to localhost:5432" rather than anything
naming the socket. Keeping it in connect_args also means DATABASE_URL stays
a plain credentials-and-database URL in both environments, so the local and
deployed values differ only by their contents, not their shape.

Note the deliberate asymmetry with the frontend's API_BASE (see
packages/api-client/_base.js): there, the relative URL is a security
boundary. Here it is only plumbing.
"""
from __future__ import annotations

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://localhost/ultimate_bookkeeping",
)

# Set by the Cloud Run deployment (see .github/workflows/deploy.yml), unset
# everywhere else — local dev and both CI database jobs connect over TCP and
# leave `connect_args` empty, so this file behaves exactly as before outside
# Cloud Run.
CLOUD_SQL_CONNECTION_NAME = os.environ.get("CLOUD_SQL_CONNECTION_NAME")


def cloud_sql_connect_args() -> dict[str, str]:
    """Extra asyncpg connect arguments for reaching Cloud SQL over its Unix
    socket; empty everywhere else.

    Exported rather than inlined because EVERY engine that talks to the
    deployed database must apply it, and there is more than one: this module
    builds the app's engine, and alembic/env.py builds a separate engine of
    its own via `async_engine_from_config`. When only this module applied the
    socket path, `alembic upgrade head` on Cloud Run fell back to asyncpg's
    default of TCP 127.0.0.1:5432 and failed with a connection-refused error
    that never mentions sockets or Cloud SQL — while the app itself connected
    fine, so nothing else looked wrong. Import this instead of re-deriving it.

    Note `host` is the socket DIRECTORY: asyncpg appends "/.s.PGSQL.5432"
    itself, which is exactly where Cloud Run mounts the socket. Don't append
    the socket filename here.
    """
    if not CLOUD_SQL_CONNECTION_NAME:
        return {}
    return {"host": f"/cloudsql/{CLOUD_SQL_CONNECTION_NAME}"}


_connect_args: dict[str, str] = cloud_sql_connect_args()

# CONNECTION BUDGET — these four numbers are one arithmetic statement, and
# breaking it is silent until load arrives.
#
# Postgres refuses connections past `max_connections`, which on Cloud SQL is
# a function of the machine tier, NOT something this app configures:
# db-f1-micro allows 25 (verified against the live instance). Cloud Run
# multiplies whatever pool each container holds by however many containers
# it decides to run. So the real constraint is:
#
#     max-instances x (pool_size + max_overflow)  <=  usable connections
#
# It was previously violated by a factor of nearly three — max-instances 10
# x (5 + 2) = 70 against a ceiling of 25 — while the comment here claimed
# the pool "keeps total connections under that ceiling as instance count
# grows". It does not; the pool size alone says nothing without the instance
# count, and that number lives in a different file (.github/workflows/
# deploy.yml). Under sustained load Postgres would have started refusing
# connections before Cloud Run looked busy, so the symptom would have
# appeared as random 5xx on sales rather than as anything resembling
# capacity.
#
# tests/test_connection_budget.py asserts the inequality by reading BOTH
# files, because that is the only place the two halves meet.
CLOUD_SQL_MAX_CONNECTIONS = 25  # db-f1-micro; re-check if the tier changes

# Held back from the service: Postgres reserves 3 for superusers, and
# operations need headroom — the Alembic migration job (NullPool, 1
# connection, see alembic/env.py), a Cloud SQL Auth Proxy session for
# debugging, the occasional psql.
RESERVED_CONNECTIONS = 9

POOL_SIZE = 3
MAX_OVERFLOW = 1
CONNECTIONS_PER_CONTAINER = POOL_SIZE + MAX_OVERFLOW

engine = create_async_engine(
    DATABASE_URL,
    future=True,
    connect_args=_connect_args,
    # Cloud Run freezes idle instances and reclaims them without warning, so
    # a pooled connection can be dead while still looking checked-in. Without
    # pre_ping the first request after an idle period fails rather than
    # transparently reconnecting — on this app that surfaces as a failed sale
    # sync, which the offline queue would then retry against an endpoint that
    # is actually healthy. Cheap round-trip; worth it.
    pool_pre_ping=True,
    # Small on purpose — see the connection budget above. Requests wait for a
    # pooled connection rather than opening a new one, which is the correct
    # trade here: a cashier waiting 50ms for a pool slot is fine, a sale
    # failing because Postgres refused the connection is not.
    pool_size=POOL_SIZE,
    max_overflow=MAX_OVERFLOW,
    pool_recycle=1800,
)
SessionLocal = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
