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

LOCAL DEV: for running the server itself (not tests) without real Firebase
credentials, see `_ensure_firebase_app`'s docstring below for how the
Firebase Auth emulator (`FIREBASE_AUTH_EMULATOR_HOST`) fits in — it is a
local-development-only affordance with no code branch of its own in this
module; the Admin SDK honours that variable natively. Its absence changes
nothing about the fail-closed behavior described above.

PROVISIONING INVARIANT (Nana's medium finding — read this before writing any
account-creation code, in this repo or in /apps/admin):

    Every Firebase user MUST be created with an *explicit* `uid` equal to
    the intended `users.id` UUID, e.g.:

        firebase_admin.auth.create_user(uid=str(user_id), ...)

    `users.id` (app/models.py) is a UUID column, and `get_current_user`
    below resolves a request's identity by parsing the verified token's
    `uid` claim as a UUID and looking it up as `users.id` (design.md §2.2:
    "users.id mirrors the Firebase UID"). Firebase's *default* auto-generated
    UIDs — what you get from the Console "Add user" UI, or from
    `create_user()` called without `uid=` — are 28-character non-UUID
    strings. Such a uid can *never* be parsed as a UUID, so it can never
    match any `users` row, no matter how correctly an admin later inserts
    one. There is no provisioning tooling in this repo (outlet app only —
    see CLAUDE.md); a Firebase-side + `users`-row provisioning flow belongs
    in /apps/admin, and MUST:

      1. Generate (or accept) the intended `users.id` UUID first.
      2. Call `create_user(uid=str(that_uuid), ...)` — never call
         `create_user()` without `uid=`, and never let the Console UI create
         the account.
      3. Insert the `users` row with that same UUID as `id`, in the same
         logical operation (ideally with compensation/rollback if either
         side fails, so the two can't drift out of sync).

    Getting this wrong produces a token that verifies successfully — the
    account is real, the password/SSO works — but can never resolve to a
    `users` row. The resulting 403 (`USER_NOT_PROVISIONED`, below) is
    indistinguishable *to the caller* from "admin hasn't provisioned this
    account yet", even after the admin has correctly inserted the `users`
    row, because the row's `id` and the Firebase uid can never be equal.
    That response is deliberately uninformative (Nana: no information leak
    to a caller, provisioned or not) — see `get_current_user`'s uid-parse
    branch for where this gets logged server-side instead, distinctly from
    an ordinary "not provisioned yet" case, so an operator debugging a
    "my staff can't log in" ticket has something to go on.
"""
from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import AppError
from app.models import User

logger = logging.getLogger(__name__)

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

    LOCAL DEV ONLY — Firebase Auth emulator (`FIREBASE_AUTH_EMULATOR_HOST`):

    This function does nothing special to support the emulator — there is no
    branch on `FIREBASE_AUTH_EMULATOR_HOST` anywhere in this module, and that
    is deliberate. `firebase_admin`/`google-auth` already honour that env var
    natively, entirely below this codebase:

      - `firebase_admin.auth.verify_id_token` (called from `verify_token`
        below) checks `FIREBASE_AUTH_EMULATOR_HOST` itself. When set, it
        trusts the emulator's unsigned tokens and verifies them locally
        (issuer/audience/subject checks only) instead of fetching Google's
        public signing certs and checking a real signature — no network call
        to Google is made either way once the var is set.
      - Because of that, real Application Default Credentials are never
        actually needed to verify a token against the emulator — only a
        resolvable project id is (see `App._lookup_project_id`), which
        `FIREBASE_PROJECT_ID` already provides via `options["projectId"]`
        above. `credentials.ApplicationDefault()` is constructed either way,
        but its lazy `get_credential()` is never invoked on this path, so a
        developer with no service-account key and no `gcloud auth
        application-default login` can still verify tokens purely against a
        locally-running `firebase emulators:start --only auth`.
      - This was verified by hand against a real `firebase emulators:start
        --only auth` instance (see apps/api/README.md "Firebase Auth
        emulator" section) — an emulator-issued ID token round-tripped
        through this exact function with no credentials configured at all.

    Net effect: setting `FIREBASE_AUTH_EMULATOR_HOST` (+ `FIREBASE_PROJECT_ID`,
    any string — it just has to match what the developer's emulator/dev
    Firebase config uses, it is never a real GCP project) is a pure
    environment-level affordance, not a code path this module adds or could
    accidentally leave enabled. Its ABSENCE changes nothing about today's
    fail-closed behavior (see `verify_token`'s docstring and the module
    docstring above) — with no `FIREBASE_AUTH_EMULATOR_HOST` set, this
    function behaves exactly as it did before the emulator was ever
    considered: real ADC, real signature verification, real network calls to
    Google, fail closed on any problem.

    NEVER set `FIREBASE_AUTH_EMULATOR_HOST` outside a developer's own machine
    or CI. A deployed environment with this variable set would accept ANY
    locally-forged, unsigned "ID token" for ANY uid — that is what makes the
    emulator useful for local development and exactly why it must never be
    reachable from a production configuration. There is deliberately no
    runtime guard against this in application code (an allowlist of
    "safe" hosts would be trivially spoofable and would just move the trust
    boundary rather than remove it) — this is a deployment-hygiene
    requirement: production secrets/env templates must never define this
    variable, and `apps/api/.env.example` documents it as local-dev-only.
    """
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app

    import firebase_admin
    from firebase_admin import credentials

    if firebase_admin._apps:  # an app was already initialized elsewhere (e.g. by another module/process)
        _firebase_app = firebase_admin.get_app()
        return _firebase_app

    if os.environ.get("FIREBASE_AUTH_EMULATOR_HOST"):
        # Loud, unmissable, server-side-only signal that this process is
        # willing to accept emulator-issued (unsigned) tokens. Never gates
        # behavior — see the docstring above — purely so an operator
        # tailing logs on a real deployment notices immediately if this
        # variable is ever set somewhere it shouldn't be.
        logger.warning(
            "FIREBASE_AUTH_EMULATOR_HOST=%s is set: this process will accept "
            "Firebase Auth EMULATOR tokens (unsigned, any uid) instead of "
            "verifying real Firebase ID tokens. This is a local-development-"
            "only affordance (see app/auth.py, apps/api/.env.example) and "
            "must NEVER be set in a deployed/production environment.",
            os.environ["FIREBASE_AUTH_EMULATOR_HOST"],
        )

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
    request: Request,
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
    # "verified token, no provisioned user" HTTP outcome as a well-formed-
    # but-unknown uid (Nana: identical response either way, no information
    # leak to the caller). But the two causes are categorically different
    # operationally, so we log them distinctly, server-side only, at a level
    # an operator will actually see — see the PROVISIONING INVARIANT note at
    # the top of this module.
    try:
        user_id = uuid.UUID(uid)
    except ValueError:
        # This is not "admin hasn't provisioned this account yet" — it is
        # structurally impossible for this uid to ever match a users row
        # (users.id is a UUID column). Overwhelmingly the most likely cause
        # is a Firebase user created without an explicit uid= (Console UI,
        # or create_user() with no uid kwarg), which is a provisioning bug,
        # not a pending-provisioning state. WARNING because this needs a
        # human to fix the *way the account was created*, not just insert a
        # row and wait.
        logger.warning(
            "Auth: token uid %r is not a well-formed UUID and can never match a users.id row "
            "(users.id is a UUID column). This is almost always caused by creating the Firebase "
            "user without an explicit uid= (e.g. via the Console UI, or create_user() without "
            "uid=) instead of uid=<intended users.id>. Fix: delete this Firebase user and "
            "recreate it with uid=<users.id UUID> — see app/auth.py module docstring.",
            uid,
        )
        user = None
    else:
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if user is None:
            # Ordinary, expected transient state: a well-formed uid with no
            # matching row yet — e.g. the admin hasn't provisioned it, or
            # provisioning is in flight. INFO, not WARNING: no action is
            # necessarily wrong here, just not-yet-done.
            logger.info(
                "Auth: token uid %s is a well-formed UUID with no matching users row (verified "
                "token, unprovisioned account).",
                user_id,
            )

    if user is None:
        raise AppError(
            code="USER_NOT_PROVISIONED",
            message="This account is verified but has no matching user record. An admin must provision it.",
            retryable=False,
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Rate-limit keying (app/rate_limit.py): set as soon as we have a real
    # `users.id`, even for a disabled account below — a disabled-account
    # retry storm should be bucketed per-account, not dog-piled onto a
    # shared IP bucket with every other device behind the same NAT. Never
    # set from unverified token claims, only from this authenticated row.
    request.state.actor_id = str(user.id)

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
