"""Add non-negative check constraint to stock_levels.quantity

Backstop for the lost-update race fixed in routers/sales.py and
routers/stock.py (see tests/test_stock_concurrency.py, which reproduces the
original defect). Both write paths check availability before writing and now
take a row lock so that check cannot be raced; this constraint is what
catches the case where a future code path forgets the lock or reintroduces
an absolute-value write without one.

sales.total_amount and expenses.amount already carried non-negative
constraints from the initial schema. stock_levels.quantity did not, which is
why a lost update could drive stock negative with nothing in the database
objecting.

WRITTEN BY HAND, deliberately. `alembic revision --autogenerate` produced an
empty migration for this change: Alembic does not reflect CHECK constraints,
so it neither generates them nor detects their absence. That means CI's
`alembic check` drift gate — which genuinely protects columns, indexes and
FKs — is blind to this class of constraint. Do not assume a green
`alembic check` means CHECK constraints in models.py are present in the
database.

Existing rows are validated when the constraint is added. Any row already
negative would fail the migration, which is the correct outcome: that is
corrupted stock needing a deliberate adjustment, not something to paper over.

Revision ID: 670d36f3d3be
Revises: 6cca266108dc
Create Date: 2026-09-15 16:41:04.262526

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "670d36f3d3be"
down_revision: Union[str, Sequence[str], None] = "6cca266108dc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_check_constraint(
        "ck_stock_levels_quantity_nonneg",
        "stock_levels",
        "quantity >= 0",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(
        "ck_stock_levels_quantity_nonneg",
        "stock_levels",
        type_="check",
    )
