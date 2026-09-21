"""Tenant-boundary authorization helpers shared across routers.

Security context (Nana's review): every endpoint that resolves an outlet_id
for an admin previously trusted the client-supplied value with no ownership
check — an authenticated admin from tenant A could pass tenant B's
outlet_id and read/write tenant B's stock, sales, and expenses (critical
IDOR). design.md §2.1-§2.2: an admin is a per-tenant business owner
(outlets.admin_id, products.admin_id) — NOT a superuser with implicit
access to every outlet in the system.

This module is the single place that resolves + authorizes an outlet for a
request. All four call sites that used to duplicate the "outlet_manager's
own outlet_id wins, admin supplies outlet_id" resolution logic
(routers/sales.py POST, routers/stock.py POST /adjustments and GET
/levels, routers/expenses.py POST) call `resolve_authorized_outlet`
instead of reimplementing it.

Effects-at-the-edges: `resolve_authorized_outlet` does the one DB read (the
effect). `_is_outlet_authorized` is the pure predicate on top of an
already-fetched row — no I/O, trivially unit-testable on its own.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser
from app.errors import AppError
from app.models import Outlet


def _is_outlet_authorized(current_user: CurrentUser, outlet: Outlet) -> bool:
    """Pure predicate: does `current_user` have rights to this outlet row?

    - admin: must be the owning admin of the outlet (outlets.admin_id,
      design.md §2.1) — admins are per-tenant business owners, not
      superusers.
    - outlet_manager: must be assigned to exactly this outlet.
    """
    if current_user.role == "admin":
        return outlet.admin_id == current_user.id
    return current_user.outlet_id == outlet.id


async def assert_client_id_not_another_tenants(
    db: AsyncSession,
    current_user: CurrentUser,
    owning_outlet_id: uuid.UUID,
) -> None:
    """Guard the idempotency-replay path against a cross-tenant client_id hit.

    Every write endpoint looks its `client_id` up FIRST, before resolving or
    authorizing an outlet (design.md §3.4 step 1 — a replayed intent must
    never fail differently than it did the first time). That lookup is
    global: `client_id` is UNIQUE across the whole table, not per outlet.

    So without this check, a `client_id` that already exists under a
    DIFFERENT tenant is indistinguishable from the caller's own replay, and
    the handler returns that other tenant's row — leaking its id, amounts and
    timestamps, AND silently discarding the caller's real write as a
    "duplicate". The lost write is the worse half: money missing from the
    books with no error anywhere.

    In practice clients send UUIDv4, so a collision is negligible and
    guessing one is infeasible. But that safety rests entirely on clients
    CHOOSING unguessable ids: the schema still accepts any non-empty string
    (`client_id: str = Field(min_length=1)`), so a modified client can pick
    "1" deliberately. This check is what makes that harmless — see the note
    on validating client_id as a UUID in README's known gaps, which would
    close the remaining cross-tenant denial vector (squatting a short id so
    another tenant's write is refused).

    Raises 409 CLIENT_ID_CONFLICT rather than returning the row. Deliberately
    not retryable: replaying the same client_id can never succeed, so the
    offline queue must surface it for resolution rather than loop.
    """
    outlet = await db.get(Outlet, owning_outlet_id)
    if outlet is not None and _is_outlet_authorized(current_user, outlet):
        return

    raise AppError(
        code="CLIENT_ID_CONFLICT",
        message=(
            "This client_id is already in use by a different outlet. It cannot be "
            "replayed here — generate a new client_id for this intent."
        ),
        retryable=False,
        status_code=409,
    )


async def resolve_authorized_outlet(
    db: AsyncSession,
    current_user: CurrentUser,
    requested_outlet_id: uuid.UUID | None,
) -> Outlet:
    """Resolve the outlet_id relevant to this request and authorize it for
    `current_user`, or raise.

    Outlet-id resolution mirrors the existing convention (api-contracts.md
    §1): an outlet_manager's own `outlet_id` (from the `users` row, i.e.
    `current_user.outlet_id`) is always authoritative and
    `requested_outlet_id` is ignored for them; an admin has no fixed
    outlet_id and must supply one via `requested_outlet_id`.

    Raises AppError(VALIDATION_ERROR, 422) if no outlet_id could be
    resolved at all (unchanged from the prior per-router behavior — this is
    "the client didn't tell us which outlet", not a tenancy failure).

    Raises AppError(OUTLET_NOT_FOUND, 404) if the outlet doesn't exist OR
    exists but belongs to a different tenant. These two cases are
    deliberately indistinguishable: a 403 for "exists but not yours" would
    let an admin enumerate other tenants' outlet_ids by observing 403 vs.
    404 (or a differing body); per Nana's finding, both collapse to the
    same 404 OUTLET_NOT_FOUND with no hint the row exists elsewhere.
    """
    outlet_id = current_user.outlet_id if current_user.role == "outlet_manager" else requested_outlet_id

    if outlet_id is None:
        raise AppError(
            code="VALIDATION_ERROR",
            message="outlet_id could not be resolved for this user",
            retryable=False,
            status_code=422,
        )

    outlet = await db.get(Outlet, outlet_id)

    if outlet is None or not _is_outlet_authorized(current_user, outlet):
        raise AppError(
            code="OUTLET_NOT_FOUND",
            message="Outlet not found.",
            retryable=False,
            status_code=404,
        )

    return outlet
