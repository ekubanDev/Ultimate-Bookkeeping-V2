"""Add product uniqueness, attribution and updated_at

Prepares the products table for a real write endpoint. Until now the only
ways to create a product were seed_dev.py or raw SQL, and the table carried
neither a uniqueness guarantee nor any record of who set a price.

1. uq_products_admin_sku — SKU is the natural key an upsert matches on, but
   nothing enforced it. Two rows could share (admin_id, sku) and a
   SELECT-then-write upsert would then update an arbitrary one. Partial on
   `sku IS NOT NULL`, because an unbarcoded item legitimately has no SKU.

2. created_by — "who changed this price, and when" is a bookkeeping question
   before it is a technical one, and this table could not answer it. There
   is no audit_log anywhere in this schema; every other mutable record
   carries created_by instead (users, sales, stock_movements, expenses).
   Nullable: rows written before this, and rows from seed_dev.py, have no
   authenticated actor behind them.

3. updated_at — a price that changed yesterday and a price set at creation
   were previously indistinguishable.

HAND-CORRECTED after autogenerate, which emitted two defects that would have
failed at runtime:
  - `app.types.GUID()` referenced with no import (NameError on upgrade).
  - create_foreign_key(None, ...) / drop_constraint(None, ...) — an unnamed
    constraint that downgrade() cannot resolve.
Worth knowing that autogenerate output is a draft here, not a result: it
missed the stock_levels CHECK constraint entirely in migration 670d36f3d3be
(Alembic does not reflect CHECK constraints) and produces uncompilable code
for custom column types like GUID.

NOTE ON EXISTING DATA: creating the unique index validates current rows. If
any tenant already holds two products with the same non-NULL SKU, this
migration fails and the deploy stops with the previous revision still
serving — which is correct. That is a genuine catalog ambiguity needing a
human decision about which row is real, not something to resolve
automatically.

Revision ID: 3defd5228372
Revises: 670d36f3d3be
Create Date: 2026-09-17 15:45:46.006598

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.types import GUID

# revision identifiers, used by Alembic.
revision: str = "3defd5228372"
down_revision: Union[str, Sequence[str], None] = "670d36f3d3be"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FK_CREATED_BY = "fk_products_created_by_users"


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("products", sa.Column("created_by", GUID(), nullable=True))
    op.add_column(
        "products",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "uq_products_admin_sku",
        "products",
        ["admin_id", "sku"],
        unique=True,
        postgresql_where=sa.text("sku IS NOT NULL"),
        sqlite_where=sa.text("sku IS NOT NULL"),
    )
    op.create_foreign_key(FK_CREATED_BY, "products", "users", ["created_by"], ["id"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(FK_CREATED_BY, "products", type_="foreignkey")
    op.drop_index(
        "uq_products_admin_sku",
        table_name="products",
        postgresql_where=sa.text("sku IS NOT NULL"),
        sqlite_where=sa.text("sku IS NOT NULL"),
    )
    op.drop_column("products", "updated_at")
    op.drop_column("products", "created_by")
