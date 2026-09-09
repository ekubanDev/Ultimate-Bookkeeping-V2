"""Local-dev seed data for the Outlet app (apps/outlet).

Without this, a freshly-migrated database has no `users` row at all, so
GET /api/v1/me returns 403 USER_NOT_PROVISIONED for literally every token
that verifies successfully (app/auth.py) — and even once a user exists, the
catalog is empty, so the POS screen has nothing to sell. This script creates
one coherent tenant: an admin, an outlet that admin owns, an outlet_manager
assigned to it, a small Ghanaian-retail product catalog, and matching
stock_levels rows.

THE PROVISIONING INVARIANT (see app/auth.py's module docstring — read that
first if this is unfamiliar): `users.id` MUST equal the Firebase uid the
user signs in with. This script does not invent that pairing on its own —
you tell it the uid(s) to use (via --admin-uid/--manager-uid or the
SEED_ADMIN_UID/SEED_MANAGER_UID env vars), and it creates the `users` rows
with exactly those ids. If you don't pass any, it generates fresh random
UUIDs and prints them — but a random UUID is *not* a real Firebase uid
unless you also create a Firebase user with that exact uid (see below).

Firebase-side provisioning:
  - If FIREBASE_AUTH_EMULATOR_HOST is set (local dev, see app/auth.py and
    apps/api/.env.example), this script ALSO creates matching users in the
    emulator via the Admin SDK, with uid=<the same UUID>, so the DB side and
    the Firebase side cannot drift — this is exactly the failure mode
    app/auth.py's PROVISIONING INVARIANT warns about. Default emulator
    login credentials are printed at the end of the run.
  - If FIREBASE_AUTH_EMULATOR_HOST is NOT set, this script only touches the
    database. You are responsible for creating matching Firebase users
    yourself (real project) with `uid=str(<the same UUID>)` explicitly
    passed to `create_user()` — never let the Console UI or a bare
    `create_user()` call assign the uid, or the account can never resolve
    to the users row this script creates (see app/auth.py for exactly why).

Idempotent: safe to re-run. Existing rows (matched by id, or by the
outlet-scoped SKU for products) are updated in place rather than
duplicated; nothing is deleted.

Safety: refuses to run against a database that looks like production (see
`_guard_against_production_database` below) — this is a heuristic, not a
guarantee; it is not a substitute for pointing DATABASE_URL at a real local
database in the first place.

Usage (from apps/api, with DATABASE_URL set/exported, venv active):
    python -m scripts.seed_dev
    python -m scripts.seed_dev --admin-uid <uuid> --manager-uid <uuid>
    SEED_ADMIN_UID=<uuid> SEED_MANAGER_UID=<uuid> python -m scripts.seed_dev
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.db import DATABASE_URL, SessionLocal, engine
from app.models import Outlet, Product, StockLevel, User

DEFAULT_ADMIN_EMAIL = "admin@ultimatebookkeeping.dev"
DEFAULT_MANAGER_EMAIL = "manager@ultimatebookkeeping.dev"
# Emulator-only credentials (never used against a real Firebase project —
# this script only ever calls create_user/update_user with a password when
# FIREBASE_AUTH_EMULATOR_HOST is set). Not a secret: the emulator has no
# real accounts behind it, and it never leaves localhost.
DEFAULT_DEV_PASSWORD = "DevPassword123!"

# (sku, name, unit_price GHS, min_stock, initial stock_levels quantity)
# min_stock is intentionally None for one row (Tampico Juice) to exercise
# the low-stock cue's null-handling path (StockLevelResponse.min_stock,
# app/schemas.py) — a product with no configured reorder threshold must
# never be treated as "always low" or "never low" by a null-unsafe
# comparison on the client.
CATALOG: list[tuple[str, str, str, int | None, int]] = [
    ("MILO-400G", "Milo 400g Tin", "45.00", 20, 5),  # below min_stock: exercises the low-stock cue
    ("SACHET-W30", "Pure Water Sachets (bag of 30)", "5.00", 50, 120),
    ("INDOMIE-70G", "Indomie Chicken Noodles 70g", "3.50", 100, 340),
    ("FRYTOL-1L", "Frytol Vegetable Oil 1L", "38.00", 15, 22),
    ("TAMPICO-500ML", "Tampico Juice 500ml", "8.00", None, 60),
    ("RICE-PERFECT-5KG", "Perfect Rice 5kg Bag", "75.00", 10, 14),
    ("PEAK-EVAP-160G", "Peak Evaporated Milk 160g Tin", "12.50", 30, 18),  # below min_stock
    ("VOLTIC-750ML", "Voltic Bottled Water 750ml", "6.00", 40, 96),
]


@dataclass(frozen=True)
class SeedIdentity:
    uid: uuid.UUID
    email: str
    display_name: str


def _guard_against_production_database(database_url: str) -> None:
    """Best-effort refusal to run against anything that looks like a real
    deployment's database. Heuristic, not a guarantee (see module
    docstring) — the actual safety boundary is "point DATABASE_URL at a
    local/dev database", this just catches the obvious ways that goes
    wrong.
    """
    url = make_url(database_url)
    host = (url.host or "").lower()
    database_name = (url.database or "").lower()

    if "prod" in database_name:
        _fail(
            f"Refusing to seed: DATABASE_URL's database name ({url.database!r}) contains "
            "'prod'. This script writes recognizable fake data (test emails, a "
            "'DevPassword123!' Firebase password) into whatever database it's pointed at — "
            "never point it at production."
        )

    loopback_hosts = {"localhost", "127.0.0.1", "::1"}
    if host and host not in loopback_hosts:
        allow = os.environ.get("SEED_ALLOW_NONLOCAL_HOST", "").strip().lower() in ("1", "true", "yes")
        if not allow:
            _fail(
                f"Refusing to seed: DATABASE_URL's host ({url.host!r}) is not localhost/127.0.0.1. "
                "This is almost always a sign DATABASE_URL points somewhere other than a local "
                "dev database. If this really is a local/dev database on a non-loopback host "
                "(e.g. a docker-compose service name), set SEED_ALLOW_NONLOCAL_HOST=1 to proceed."
            )


def _fail(message: str) -> None:
    print(f"seed_dev: {message}", file=sys.stderr)
    raise SystemExit(1)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--admin-uid",
        default=os.environ.get("SEED_ADMIN_UID"),
        help="UUID to use for both the Firebase uid and users.id of the seeded admin. "
        "Defaults to $SEED_ADMIN_UID, or a freshly generated UUID if unset.",
    )
    parser.add_argument(
        "--manager-uid",
        default=os.environ.get("SEED_MANAGER_UID"),
        help="UUID to use for both the Firebase uid and users.id of the seeded outlet_manager. "
        "Defaults to $SEED_MANAGER_UID, or a freshly generated UUID if unset.",
    )
    parser.add_argument(
        "--admin-email",
        default=os.environ.get("SEED_ADMIN_EMAIL", DEFAULT_ADMIN_EMAIL),
        help="Email to use when also creating an emulator Firebase user for the admin.",
    )
    parser.add_argument(
        "--manager-email",
        default=os.environ.get("SEED_MANAGER_EMAIL", DEFAULT_MANAGER_EMAIL),
        help="Email to use when also creating an emulator Firebase user for the manager.",
    )
    parser.add_argument(
        "--outlet-name",
        default=os.environ.get("SEED_OUTLET_NAME", "Osu Corner Shop"),
        help="Name for the seeded outlet.",
    )
    return parser.parse_args(argv)


def _resolve_uuid(raw: str | None) -> uuid.UUID:
    if raw:
        try:
            return uuid.UUID(raw)
        except ValueError:
            _fail(f"{raw!r} is not a valid UUID.")
    generated = uuid.uuid4()
    return generated


async def _upsert_user(
    session,
    *,
    user_id: uuid.UUID,
    role: str,
    outlet_id: uuid.UUID | None,
    created_by: uuid.UUID | None,
    display_name: str,
) -> User:
    existing = await session.get(User, user_id)
    if existing is not None:
        existing.role = role
        existing.outlet_id = outlet_id
        existing.created_by = created_by
        existing.display_name = display_name
        existing.is_active = True
        return existing
    user = User(
        id=user_id,
        role=role,
        outlet_id=outlet_id,
        created_by=created_by,
        display_name=display_name,
        is_active=True,
    )
    session.add(user)
    return user


async def _upsert_outlet(session, *, outlet_id: uuid.UUID, admin_id: uuid.UUID, name: str) -> Outlet:
    existing = await session.get(Outlet, outlet_id)
    if existing is not None:
        existing.admin_id = admin_id
        existing.name = name
        return existing
    outlet = Outlet(id=outlet_id, admin_id=admin_id, name=name, location="Osu, Accra")
    session.add(outlet)
    return outlet


async def _upsert_product_and_stock(
    session,
    *,
    admin_id: uuid.UUID,
    outlet_id: uuid.UUID,
    sku: str,
    name: str,
    unit_price: str,
    min_stock: int | None,
    quantity: int,
) -> Product:
    result = await session.execute(
        select(Product).where(Product.admin_id == admin_id, Product.sku == sku)
    )
    product = result.scalar_one_or_none()
    if product is None:
        product = Product(
            id=uuid.uuid4(),
            admin_id=admin_id,
            sku=sku,
            name=name,
            unit_price=Decimal(unit_price),
            min_stock=min_stock,
        )
        session.add(product)
        await session.flush()  # need product.id for the stock_levels row below
    else:
        product.name = name
        product.unit_price = Decimal(unit_price)
        product.min_stock = min_stock

    level_result = await session.execute(
        select(StockLevel).where(StockLevel.product_id == product.id, StockLevel.outlet_id == outlet_id)
    )
    level = level_result.scalar_one_or_none()
    if level is None:
        session.add(StockLevel(id=uuid.uuid4(), product_id=product.id, outlet_id=outlet_id, quantity=quantity))
    else:
        level.quantity = quantity

    return product


def _seed_firebase_emulator_users(identities: list[SeedIdentity]) -> bool:
    """Create/update matching Firebase Auth EMULATOR users, uid-for-uid with
    the `users` rows this script writes (the PROVISIONING INVARIANT —
    app/auth.py). Only ever called when FIREBASE_AUTH_EMULATOR_HOST is set
    (see caller) — this function never touches a real Firebase project.

    Returns True if it ran (so the caller can print the right follow-up
    instructions), False if it was skipped.
    """
    emulator_host = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
    if not emulator_host:
        return False

    project_id = os.environ.get("FIREBASE_PROJECT_ID")
    if not project_id:
        print(
            "seed_dev: FIREBASE_AUTH_EMULATOR_HOST is set but FIREBASE_PROJECT_ID is not — "
            "skipping emulator user creation (the Admin SDK needs a project id even against "
            "the emulator; see .env.example). Database rows were still seeded.",
            file=sys.stderr,
        )
        return False

    import firebase_admin
    from firebase_admin import auth, credentials

    if firebase_admin._apps:
        app = firebase_admin.get_app()
    else:
        app = firebase_admin.initialize_app(credentials.ApplicationDefault(), {"projectId": project_id})

    for identity in identities:
        uid = str(identity.uid)
        try:
            auth.create_user(
                uid=uid,
                email=identity.email,
                password=DEFAULT_DEV_PASSWORD,
                display_name=identity.display_name,
                app=app,
            )
            print(f"  created emulator user {identity.email} (uid={uid})")
        except auth.UidAlreadyExistsError:
            auth.update_user(
                uid,
                email=identity.email,
                password=DEFAULT_DEV_PASSWORD,
                display_name=identity.display_name,
                app=app,
            )
            print(f"  updated emulator user {identity.email} (uid={uid})")
        except auth.EmailAlreadyExistsError:
            # Another uid already claimed this email (e.g. a re-run with a
            # different --admin-uid than last time). Don't silently steal
            # the email — surface it so the developer picks a consistent
            # uid or a different email.
            print(
                f"  WARNING: email {identity.email} is already in use by a different emulator "
                f"uid than {uid} — pass --admin-uid/--manager-uid matching a prior run, or a "
                "different --admin-email/--manager-email.",
                file=sys.stderr,
            )
    return True


async def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)

    _guard_against_production_database(DATABASE_URL)

    admin_id = _resolve_uuid(args.admin_uid)
    manager_id = _resolve_uuid(args.manager_uid)
    outlet_id = uuid.uuid5(uuid.NAMESPACE_URL, f"ultimate-bookkeeping-dev-outlet:{admin_id}")

    print(f"seed_dev: seeding against {make_url(DATABASE_URL).render_as_string(hide_password=True)}")

    async with SessionLocal() as session:
        await _upsert_user(
            session,
            user_id=admin_id,
            role="admin",
            outlet_id=None,
            created_by=None,
            display_name="Ama Owusu (Admin)",
        )
        await session.flush()  # admin row must exist before the outlet FK below

        await _upsert_outlet(session, outlet_id=outlet_id, admin_id=admin_id, name=args.outlet_name)
        await session.flush()  # outlet row must exist before the manager's outlet_id FK below

        await _upsert_user(
            session,
            user_id=manager_id,
            role="outlet_manager",
            outlet_id=outlet_id,
            created_by=admin_id,
            display_name="Kojo Mensah (Outlet Manager)",
        )

        for sku, name, unit_price, min_stock, quantity in CATALOG:
            await _upsert_product_and_stock(
                session,
                admin_id=admin_id,
                outlet_id=outlet_id,
                sku=sku,
                name=name,
                unit_price=unit_price,
                min_stock=min_stock,
                quantity=quantity,
            )

        await session.commit()

    print("seed_dev: database rows ready:")
    print(f"  admin        users.id = {admin_id}  ({args.admin_email})")
    print(f"  outlet_manager users.id = {manager_id}  ({args.manager_email})")
    print(f"  outlet       outlets.id = {outlet_id}  ({args.outlet_name!r})")
    print(f"  products: {len(CATALOG)} rows (+ matching stock_levels)")

    identities = [
        SeedIdentity(uid=admin_id, email=args.admin_email, display_name="Ama Owusu (Admin)"),
        SeedIdentity(uid=manager_id, email=args.manager_email, display_name="Kojo Mensah (Outlet Manager)"),
    ]
    print()
    print("seed_dev: Firebase side —")
    ran_emulator = _seed_firebase_emulator_users(identities)
    if ran_emulator:
        print(f"  Emulator login password for both accounts: {DEFAULT_DEV_PASSWORD}")
        print("  Sign in against the emulator (e.g. Firebase JS SDK with connectAuthEmulator,")
        print(f"  or the Identity Toolkit REST API) as {args.admin_email} / {args.manager_email}")
        print("  to get an ID token that app/auth.py will accept — see apps/api/README.md.")
    else:
        print(
            "  FIREBASE_AUTH_EMULATOR_HOST is not set — no Firebase users were created/checked. "
            "If you're using a real Firebase project, you must create matching users yourself "
            f"with uid=str({admin_id}) and uid=str({manager_id}) explicitly passed to "
            "create_user() — see the PROVISIONING INVARIANT note in app/auth.py."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
