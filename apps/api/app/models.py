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
    """The catalog. `unit_price` here is what the POS displays and what
    `price_variance_flagged` is computed against (app/pricing.py), so a wrong
    row does not merely mis-price a sale — it also changes what counts as a
    suspicious one from then on.

    Two columns and one constraint were added when the write endpoint was
    built; before that the only way to create a product was seed_dev.py or
    raw SQL, and the table carried neither a uniqueness guarantee nor any
    record of who set a price.
    """

    __tablename__ = "products"
    __table_args__ = (
        # SKU is the natural key an upsert matches on (see the write endpoint
        # and seed_dev.py's `_upsert_product_and_stock`), but nothing enforced
        # it — two rows could share (admin_id, sku) and a SELECT-then-write
        # upsert would then update an arbitrary one of them. That is the same
        # unguarded read-modify-write shape that produced the stock oversell
        # race; here there was not even a constraint to catch it afterwards.
        #
        # Partial, because sku is legitimately NULL for an unbarcoded item and
        # Postgres would otherwise treat every NULL as distinct anyway —
        # stating it explicitly matches the existing pattern on
        # stock_movements.client_id and keeps SQLite and Postgres in step.
        Index(
            "uq_products_admin_sku",
            "admin_id",
            "sku",
            unique=True,
            postgresql_where=text("sku IS NOT NULL"),
            sqlite_where=text("sku IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    admin_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    sku: Mapped[str | None] = mapped_column(Text, nullable=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    min_stock: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Attribution. "Who changed this price, and when" is a bookkeeping
    # question before it is a technical one, and this table could not answer
    # it: there is no audit_log anywhere in this schema (every other mutable
    # record carries created_by instead — users, sales, stock_movements,
    # expenses). Nullable because rows predating the write endpoint, and rows
    # written by seed_dev.py, have no authenticated actor behind them.
    created_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StockLevel(Base):
    __tablename__ = "stock_levels"
    __table_args__ = (
        UniqueConstraint("product_id", "outlet_id", name="uq_stock_levels_product_outlet"),
        # Backstop, not the primary control. Both write paths
        # (routers/sales.py, routers/stock.py) check availability before
        # writing and now take a row lock so that check cannot be raced —
        # this constraint is what catches it if a future code path forgets
        # the lock, or reintroduces an absolute-value write without one.
        #
        # sales.total_amount and expenses.amount already had non-negative
        # constraints; stock_levels.quantity did not, which is why a lost
        # update could silently drive stock negative with nothing objecting.
        # Code review found the gap (Efua and Adjoa independently) after the
        # race itself was reproduced in tests/test_stock_concurrency.py.
        CheckConstraint("quantity >= 0", name="ck_stock_levels_quantity_nonneg"),
    )

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
    # subtotal_amount is stored (not just derivable from line_total sums) so
    # the response can return it without recomputation drift risk — see
    # app/pricing.py for the server-authoritative computation this mirrors.
    subtotal_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    total_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    # Server-authoritative pricing (Ama's spec, prompted by Nana's skimming
    # finding): `discount_type`/`discount_value` are the raw cashier input
    # (percentage 0.00-100.00, or a fixed GHS amount); `discount_amount` is
    # ALWAYS server-computed from them (app/pricing.py) and never accepted
    # directly from the client.
    discount_type: Mapped[str] = mapped_column(
        Enum("percentage", "fixed", name="sale_discount_type", native_enum=False),
        nullable=False,
        default="fixed",
    )
    discount_value: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
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
    # Price actually charged, persisted verbatim — never replaced by a
    # catalog lookup. A completed, paid transaction is not repriced after
    # the fact (Ama's spec).
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    line_total: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    # Audit-only snapshot of products.unit_price read at transaction-commit
    # time — never used in money math (app/pricing.py never reads this
    # column back into a computation, only writes it).
    catalog_unit_price_at_sale: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    # Flag-only signal (never blocks/delays/alters the sale) — true when
    # `unit_price` deviates from `catalog_unit_price_at_sale` beyond
    # tolerance; see app/pricing.py `is_price_variance_flagged`.
    price_variance_flagged: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )

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
