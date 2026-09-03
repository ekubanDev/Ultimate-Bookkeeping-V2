"""SQLAlchemy models for the tables needed by POST /api/v1/sales.

Mirrors ultimate-bookkeeping-v2-design.md §2. Only the columns specified there
are modeled; `expenses`, `liabilities`, `settlements` are out of scope for this
endpoint and are left as open items per design doc §4.

Enum-like columns (`users.role`, `sales.status`, `stock_movements.reason`) use
SQLAlchemy's `Enum` with `native_enum=False` so the same model definitions work
identically against Postgres (production) and SQLite (tests) — Postgres native
enum types would need a separate migration path per dialect, which isn't worth
the complexity for this MVP. This is documented as a resolved ambiguity, not
specified explicitly in the design doc.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.types import GUID


class Outlet(Base):
    __tablename__ = "outlets"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    admin_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    role: Mapped[str] = mapped_column(
        Enum("admin", "outlet_manager", name="user_role", native_enum=False), nullable=False
    )
    outlet_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("outlets.id"), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Revocation path (Nana's high-severity finding: no way to disable a
    # compromised/offboarded account short of deleting the Firebase user
    # entirely). Checked by `get_current_user` on the same row it already
    # fetches — no extra query, no Firebase round-trip. Schema addition:
    # needs a line in design.md §2.2 (not edited here — that doc is owned
    # by Kwame/Ama).
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"), default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Product(Base):
    __tablename__ = "products"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    admin_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    sku: Mapped[str | None] = mapped_column(Text, nullable=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    min_stock: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StockLevel(Base):
    __tablename__ = "stock_levels"
    __table_args__ = (UniqueConstraint("product_id", "outlet_id", name="uq_stock_levels_product_outlet"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    product_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("products.id"), nullable=False)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("outlets.id"), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StockMovement(Base):
    """Append-only stock ledger (design.md §2.5).

    Idempotency note (resolved ambiguity, POST /api/v1/stock/adjustments):
    `client_id` is the idempotency anchor for offline-originated movements,
    but it is NOT globally unique across this table — a single sale with N
    line items inserts N stock_movements rows that all share the *sale's*
    client_id (see routers/sales.py). A plain `UNIQUE(client_id)` constraint
    would therefore break multi-line-item sales.

    Movements created via POST /api/v1/stock/adjustments (reason in
    'restock'/'adjustment'; 'sale' and 'transfer' are never accepted from
    that endpoint — 'sale' is written exclusively by the sales endpoint,
    'transfer' is reserved for a future admin-console flow) always insert
    exactly one row per client_id, so we can safely enforce uniqueness
    scoped to `reason <> 'sale'` — a partial/conditional unique index rather
    than a table-wide unique constraint. This also means an adjustment's
    idempotency lookup must filter `reason != 'sale'` so it can never
    coincidentally match a sale-driven row that happens to carry the same
    client_id value (astronomically unlikely with UUIDs, but the lookup is
    scoped defensively regardless — see routers/stock.py `_fetch_movement_by_client_id`).
    """

    __tablename__ = "stock_movements"
    __table_args__ = (
        Index(
            "uq_stock_movements_client_id_non_sale",
            "client_id",
            unique=True,
            postgresql_where=text("reason <> 'sale' AND client_id IS NOT NULL"),
            sqlite_where=text("reason <> 'sale' AND client_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    product_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("products.id"), nullable=False)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("outlets.id"), nullable=False)
    delta: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(
        Enum("sale", "restock", "adjustment", "transfer", name="stock_movement_reason", native_enum=False),
        nullable=False,
    )
    reference_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True)
    client_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Sale(Base):
    __tablename__ = "sales"
    __table_args__ = (
        CheckConstraint("total_amount >= 0", name="ck_sales_total_amount_nonneg"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("outlets.id"), nullable=False)
    client_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    payment_method: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        Enum("completed", "voided", name="sale_status", native_enum=False),
        nullable=False,
        default="completed",
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    device_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    line_items: Mapped[list["SaleLineItem"]] = relationship(back_populates="sale", cascade="all, delete-orphan")


class SaleLineItem(Base):
    __tablename__ = "sale_line_items"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    sale_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("sales.id"), nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("products.id"), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    line_total: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    sale: Mapped["Sale"] = relationship(back_populates="line_items")


class Expense(Base):
    """design.md §2.8 — follows the `sales` append-only-ledger template:
    id, outlet_id, client_id UNIQUE, amount, status, created_by, created_at,
    plus expense-specific columns (category, note, device_recorded_at).
    """

    __tablename__ = "expenses"
    __table_args__ = (CheckConstraint("amount >= 0", name="ck_expenses_amount_nonneg"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("outlets.id"), nullable=False)
    client_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        Enum("recorded", "voided", name="expense_status", native_enum=False),
        nullable=False,
        default="recorded",
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    device_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
