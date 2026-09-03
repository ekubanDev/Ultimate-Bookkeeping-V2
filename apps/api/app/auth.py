"""Auth dependency: real Firebase ID token verification + users-table lookup.

Resolves the current user (id, role, outlet_id) from the `Authorization:
Bearer <token>` header, per api-contracts.md §1: "Auth: Firebase ID token ...
verified server-side; role (`admin`/`outlet_manager`) and `outlet_id` resolved
from the `users` table, never trusted from the request body."

Effects-at-the-edges: `verify_token` is the ONLY place that talks to
firebase_admin (the effect — network/crypto verification of the token
signature). Everything downstream of it (`get_current_user`) is pure
lookup + construction: it takes the verified uid, does a DB read, and builds
a `CurrentUser`. Token claims beyond the uid (`sub`) are never trusted for
role/outlet_id — those come exclusively from the `users` row (design.md §2.2:
`users.id` mirrors the Firebase UID).

Tests never need real Firebase credentials: they either override
`get_current_user` wholesale via `app.dependency_overrides` (existing
suite, see tests/conftest.py), or monkeypatch `verify_token` directly to
exercise the real lookup/construction path (tests/test_auth.py). Importing
this module never initializes firebase_admin or requires
GOOGLE_APPLICATION_CREDENTIALS — the Admin SDK is initialized lazily, once,
on first real call to `verify_token`.

There is no insecure fallback: if firebase_admin can't verify a token for any
reason (bad signature, expired, revoked, SDK not configured, network error),
`verify_token` raises `TokenVerificationError` and the request fails closed
with 401. The only way around real verification is the explicit
`dependency_overrides` seam FastAPI's TestClient/AsyncClient use in tests.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import AppError
from app.models import User

# Module-level guard for the lazily-initialized Firebase Admin App. `None`
# until the first real call to `verify_token` (never touched by tests that
# monkeypatch `verify_token` or override `get_current_user`).
_firebase_app = None


class TokenVerificationError(Exception):
    """Raised by `verify_token` when a bearer token is missing, malformed,
    expired, revoked, or otherwise fails Firebase verification — including
    the Admin SDK itself being unavailable/misconfigured. Deliberately a
    single exception type so `get_current_user` has exactly one thing to
    catch and translate into a 401; there is no path that treats a
    verification failure as "logged in anyway".
    """


def _ensure_firebase_app():
    """Lazily initialize the Firebase Admin SDK exactly once (module-level
    guard). Uses GOOGLE_APPLICATION_CREDENTIALS / ambient default
    credentials via `firebase_admin.credentials.ApplicationDefault()`;
    `FIREBASE_PROJECT_ID` is an optional override for the project id when it
    can't be inferred from the credentials.

    `firebase_admin` is imported inside this function, not at module import
    time, so `import app.auth` never requires credentials or network access.
    """
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app

    import firebase_admin
    from firebase_admin import credentials

    if firebase_admin._apps:  # an app was already initialized elsewhere (e.g. by another module/process)
        _firebase_app = firebase_admin.get_app()
        return _firebase_app

    options: dict[str, str] = {}
    project_id = os.environ.get("FIREBASE_PROJECT_ID")
    if project_id:
        options["projectId"] = project_id

    cred = credentials.ApplicationDefault()
    _firebase_app = firebase_admin.initialize_app(cred, options or None)
    return _firebase_app


def verify_token(token: str) -> str:
    """SEAM: verify a Firebase ID token and return the Firebase UID (`sub`).

    This is the only function in the codebase that calls
    `firebase_admin.auth.verify_id_token`. Token claims other than the uid
    are discarded immediately — role/outlet_id are never derived from claims,
    only from the `users` table (see `get_current_user`).

    Tests monkeypatch this function directly (`app.auth.verify_token`)
    instead of needing real Firebase credentials — see tests/test_auth.py.
    """
    try:
        app = _ensure_firebase_app()
        from firebase_admin import auth as firebase_auth

        decoded = firebase_auth.verify_id_token(token, app=app)
    except TokenVerificationError:
        raise
    except Exception as exc:  # noqa: BLE001 — normalize ANY firebase_admin/SDK/network failure
        # to one exception type. Fail closed: every failure mode here (bad
        # signature, expired, revoked, misconfigured SDK, no credentials,
        # network error reaching Google) must become a 401, never a bypass.
        raise TokenVerificationError(f"Firebase ID token verification failed: {exc}") from exc

    uid = decoded.get("uid")
    if not uid:
        raise TokenVerificationError("Decoded Firebase token has no uid claim")
    return uid


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    role: str
    outlet_id: uuid.UUID | None


async def get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    token = _extract_bearer_token(authorization)

    try:
        uid = verify_token(token)
    except TokenVerificationError as exc:
        raise AppError(
            code="UNAUTHENTICATED",
            message="Invalid or expired authentication token.",
            retryable=False,
            status_code=status.HTTP_401_UNAUTHORIZED,
        ) from exc

    # uid mirrors users.id per design.md §2.2. A uid that isn't a valid UUID
    # can't correspond to any row either way — fold it into the same
    # "verified token, no provisioned user" outcome as a well-formed-but-
    # unknown uid, rather than treating it as a separate auth failure.
    try:
        user_id = uuid.UUID(uid)
    except ValueError:
        user = None
    else:
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()

    if user is None:
        raise AppError(
            code="USER_NOT_PROVISIONED",
            message="This account is verified but has no matching user record. An admin must provision it.",
            retryable=False,
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Revocation path (Nana's finding, high severity): a disabled account
    # must be rejected here, on the same users row we already fetched — no
    # extra query, no Firebase Admin SDK round-trip to revoke/check tokens.
    # This is deliberately checked after "does a user row exist" (a
    # not-provisioned account isn't "disabled", it never existed) and before
    # any role/outlet_id is handed back to a caller.
    if not user.is_active:
        raise AppError(
            code="USER_DISABLED",
            message="This account has been disabled.",
            retryable=False,
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Role/outlet_id come exclusively from the users row — never from the
    # token claims or (for endpoints that also accept a body) the request
    # body. Per api-contracts.md §1.
    return CurrentUser(id=user.id, role=user.role, outlet_id=user.outlet_id)


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise AppError(
            code="UNAUTHENTICATED",
            message="Missing or malformed Authorization header.",
            retryable=False,
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise AppError(
            code="UNAUTHENTICATED",
            message="Missing or malformed Authorization header.",
            retryable=False,
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    return token
