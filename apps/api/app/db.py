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

_connect_args: dict[str, str] = {}
if CLOUD_SQL_CONNECTION_NAME:
    # asyncpg treats a `host` that starts with "/" as a socket *directory*
    # and appends "/.s.PGSQL.5432" itself — which is exactly where Cloud Run
    # mounts the socket. Don't append the socket filename here.
    _connect_args["host"] = f"/cloudsql/{CLOUD_SQL_CONNECTION_NAME}"

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
    # Cloud Run scales to many small instances rather than few large ones, and
    # Cloud SQL enforces a per-instance connection ceiling (~25 on db-f1-micro).
    # A small pool per container keeps total connections under that ceiling as
    # instance count grows.
    pool_size=5,
    max_overflow=2,
    pool_recycle=1800,
)
SessionLocal = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
