"""Alembic migration environment.

Async SQLAlchemy engine, `run_sync` bridges Alembic's sync migration API onto
it (per app/db.py's async engine setup). `DATABASE_URL` is read from the
environment — same variable app/db.py uses for the app itself — rather than
a hardcoded URL, so the same migration set applies cleanly whatever
Postgres instance/tenant this is invoked against (local dev, CI, staging,
prod). There is deliberately no fallback to a bundled default: running
migrations against the wrong (or an accidentally-implicit) database is worse
than failing loudly.
"""
from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# Import the app's declarative Base and models module so Base.metadata is
# fully populated (SQLAlchemy models only register themselves on their
# metadata when the module defining them has been imported) before it's
# handed to Alembic as target_metadata for autogenerate.
from app.db import Base
import app.models  # noqa: F401  (import side effect: registers tables on Base.metadata)

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Alembic reads the target database "
            "from the environment rather than alembic.ini — set "
            "DATABASE_URL (e.g. postgresql+asyncpg://user:pass@host/db) "
            "before running `alembic upgrade`/`alembic revision "
            "--autogenerate`."
        )
    return url


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = _get_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = _get_database_url()

    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""

    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
