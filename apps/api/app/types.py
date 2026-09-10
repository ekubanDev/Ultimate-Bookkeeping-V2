"""Portable column types shared across models.

Production runs on Postgres (per ultimate-bookkeeping-v2-design.md §2); the test
suite runs against in-memory SQLite via aiosqlite for speed/isolation. GUID is a
dialect-aware type so the same models work against both without a second schema
to maintain.
"""
from __future__ import annotations

import uuid

from sqlalchemy import CHAR, TypeDecorator
from sqlalchemy.dialects.postgresql import UUID as PG_UUID


class GUID(TypeDecorator):
    """Platform-independent UUID type.

    Uses Postgres' native UUID type when available, otherwise stores as a
    stringified hex CHAR(32) (SQLite has no native UUID type).
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(32))

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        if dialect.name == "postgresql":
            return str(value)
        if not isinstance(value, uuid.UUID):
            value = uuid.UUID(str(value))
        return value.hex

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(value)
