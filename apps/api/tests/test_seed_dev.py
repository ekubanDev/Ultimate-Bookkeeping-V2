"""Unit tests for scripts/seed_dev.py's Firebase-provisioning logic.

Scope, deliberately: these tests cover the CLI-argument guardrails and the
real-Firebase-project provisioning function (`_seed_firebase_real_users`),
with the Admin SDK's `auth` calls mocked — no network access, no real
Firebase project, no service-account credentials required or used.

Explicitly OUT of scope here (see apps/api/README.md's "What was NOT
verified" section for this change): actually calling a real Firebase
project. That cannot be done from this environment (no credentials, and it
would be inappropriate to touch a real project from a test suite). The
emulator path (`_seed_firebase_emulator_users`) is exercised end to end
manually against a real running `firebase emulators:start --only auth`
instance (documented in the README), not re-verified here — it is
unchanged by this work other than sitting alongside the new real-project
path, and its behavior is a straightforward Admin-SDK-emulator interaction
already covered by that manual run.
"""
from __future__ import annotations

import argparse
import uuid
from types import SimpleNamespace

import pytest
from firebase_admin import auth as firebase_auth

from scripts.seed_dev import (
    DEFAULT_DEV_PASSWORD,
    SeedIdentity,
    _guard_against_production_firebase_project,
    _seed_firebase_real_users,
    _validate_firebase_mode_args,
)

ADMIN_UID = uuid.UUID("11111111-1111-4111-8111-111111111111")
MANAGER_UID = uuid.UUID("22222222-2222-4222-8222-222222222222")


def _args(**overrides) -> argparse.Namespace:
    base = {"allow_real_firebase": False, "real_firebase_project_id": None}
    base.update(overrides)
    return argparse.Namespace(**base)


def _identity(uid: uuid.UUID = ADMIN_UID, email: str = "admin@example.com") -> SeedIdentity:
    return SeedIdentity(uid=uid, email=email, display_name="Ama Owusu (Admin)")


def _fake_user_record(uid: str, email: str) -> SimpleNamespace:
    # Real firebase_admin.auth.UserRecord exposes .uid / .email as
    # properties; a SimpleNamespace with the same attribute names is
    # sufficient for the pure comparison logic under test.
    return SimpleNamespace(uid=uid, email=email)


# --------------------------------------------------------------------------
# --allow-real-firebase / --real-firebase-project-id CLI validation
# --------------------------------------------------------------------------


class TestValidateFirebaseModeArgs:
    def test_neither_flag_set_is_allowed(self, monkeypatch):
        monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
        _validate_firebase_mode_args(_args())  # must not raise

    def test_allow_real_firebase_without_project_id_is_refused(self, monkeypatch):
        monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
        with pytest.raises(SystemExit):
            _validate_firebase_mode_args(_args(allow_real_firebase=True))

    def test_project_id_without_allow_real_firebase_is_refused(self, monkeypatch):
        monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
        with pytest.raises(SystemExit):
            _validate_firebase_mode_args(_args(real_firebase_project_id="acme-prod-1234"))

    def test_allow_real_firebase_with_emulator_host_set_is_refused(self, monkeypatch):
        # This is the "opt-in required, never side-effected by an ambient
        # env var" guardrail combined with the emulator-vs-real mutual
        # exclusivity check.
        monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")
        with pytest.raises(SystemExit):
            _validate_firebase_mode_args(
                _args(allow_real_firebase=True, real_firebase_project_id="acme-1234")
            )

    def test_allow_real_firebase_with_explicit_project_id_and_no_emulator_host_is_allowed(
        self, monkeypatch
    ):
        monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
        _validate_firebase_mode_args(
            _args(allow_real_firebase=True, real_firebase_project_id="acme-1234")
        )  # must not raise

    def test_stray_firebase_project_id_env_var_is_never_consulted(self, monkeypatch):
        # The whole point of --real-firebase-project-id is that it is NEVER
        # inherited from $FIREBASE_PROJECT_ID (reserved for the emulator
        # path). Setting that env var must not satisfy the requirement.
        monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
        monkeypatch.setenv("FIREBASE_PROJECT_ID", "some-other-project")
        with pytest.raises(SystemExit):
            _validate_firebase_mode_args(_args(allow_real_firebase=True))


# --------------------------------------------------------------------------
# Production-looking real-project-id guard
# --------------------------------------------------------------------------


class TestGuardAgainstProductionFirebaseProject:
    def test_ordinary_project_id_passes(self, monkeypatch):
        monkeypatch.delenv("SEED_ALLOW_PROD_LOOKING_FIREBASE_PROJECT", raising=False)
        _guard_against_production_firebase_project("ultimate-bookkeeping-dev")  # must not raise

    def test_prod_looking_project_id_refused_by_default(self, monkeypatch):
        monkeypatch.delenv("SEED_ALLOW_PROD_LOOKING_FIREBASE_PROJECT", raising=False)
        with pytest.raises(SystemExit):
            _guard_against_production_firebase_project("ultimate-bookkeeping-prod")

    def test_prod_looking_project_id_allowed_with_explicit_override(self, monkeypatch):
        monkeypatch.setenv("SEED_ALLOW_PROD_LOOKING_FIREBASE_PROJECT", "1")
        _guard_against_production_firebase_project("ultimate-bookkeeping-prod")  # must not raise


# --------------------------------------------------------------------------
# _seed_firebase_real_users — Admin SDK auth.* calls mocked throughout.
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _stub_firebase_app_bootstrap(monkeypatch):
    """`_seed_firebase_real_users` calls `firebase_admin.get_app(name)` /
    `firebase_admin.initialize_app(..., name=name)` to obtain an App object
    before making any `auth.*` calls. Stub both so no real App registry
    entry or ApplicationDefault credential lookup is involved — the tests
    below only care about the `auth.*` call logic downstream of that.
    """
    import firebase_admin

    sentinel_app = object()
    monkeypatch.setattr(firebase_admin, "get_app", lambda name=None: (_ for _ in ()).throw(ValueError("no app")))
    monkeypatch.setattr(firebase_admin, "initialize_app", lambda cred, options=None, name=None: sentinel_app)
    return sentinel_app


class TestSeedFirebaseRealUsersNewAccount:
    def test_creates_user_without_password_and_prints_reset_link_once(self, monkeypatch, capsys):
        monkeypatch.setattr(
            firebase_auth, "get_user", lambda uid, app=None: (_ for _ in ()).throw(firebase_auth.UserNotFoundError("nope"))
        )
        monkeypatch.setattr(
            firebase_auth,
            "get_user_by_email",
            lambda email, app=None: (_ for _ in ()).throw(firebase_auth.UserNotFoundError("nope")),
        )
        create_calls = []

        def fake_create_user(**kwargs):
            create_calls.append(kwargs)
            return _fake_user_record(kwargs["uid"], kwargs["email"])

        monkeypatch.setattr(firebase_auth, "create_user", fake_create_user)
        monkeypatch.setattr(
            firebase_auth, "generate_password_reset_link", lambda email, app=None: f"https://example.test/reset/{email}"
        )

        ok = _seed_firebase_real_users([_identity()], "acme-1234")

        assert ok is True
        assert len(create_calls) == 1
        call = create_calls[0]
        assert call["uid"] == str(ADMIN_UID)
        assert call["email"] == "admin@example.com"
        # The core "never a real password" guardrail: no password kwarg at
        # all, and in particular never the shared emulator-only constant.
        assert "password" not in call
        assert DEFAULT_DEV_PASSWORD not in repr(call)

        out = capsys.readouterr().out
        assert "https://example.test/reset/admin@example.com" in out
        assert "no password set" in out
        # The shared dev password must never appear anywhere in real-path
        # output either.
        assert DEFAULT_DEV_PASSWORD not in out


class TestSeedFirebaseRealUsersIdempotency:
    def test_existing_uid_with_matching_email_is_left_untouched(self, monkeypatch, capsys):
        monkeypatch.setattr(
            firebase_auth,
            "get_user",
            lambda uid, app=None: _fake_user_record(str(ADMIN_UID), "admin@example.com"),
        )
        create_called = []
        monkeypatch.setattr(firebase_auth, "create_user", lambda **kw: create_called.append(kw))
        monkeypatch.setattr(
            firebase_auth, "generate_password_reset_link", lambda *a, **kw: pytest.fail("must not be called")
        )
        # get_user_by_email must not even be consulted once uid resolves.
        monkeypatch.setattr(
            firebase_auth, "get_user_by_email", lambda *a, **kw: pytest.fail("must not be called")
        )

        ok = _seed_firebase_real_users([_identity()], "acme-1234")

        assert ok is True
        assert create_called == []
        out = capsys.readouterr().out
        assert "already exists" in out
        assert "matches" in out

    def test_existing_uid_with_mismatched_email_is_refused(self, monkeypatch, capsys):
        monkeypatch.setattr(
            firebase_auth,
            "get_user",
            lambda uid, app=None: _fake_user_record(str(ADMIN_UID), "someone-else@example.com"),
        )
        create_called = []
        monkeypatch.setattr(firebase_auth, "create_user", lambda **kw: create_called.append(kw))

        ok = _seed_firebase_real_users([_identity(email="admin@example.com")], "acme-1234")

        assert ok is False
        assert create_called == []
        err = capsys.readouterr().err
        assert "does not match" in err
        assert "Refusing to modify" in err


class TestSeedFirebaseRealUsersEmailCollision:
    def test_email_claimed_by_a_different_uid_is_refused_not_overwritten(self, monkeypatch, capsys):
        # uid is free...
        monkeypatch.setattr(
            firebase_auth, "get_user", lambda uid, app=None: (_ for _ in ()).throw(firebase_auth.UserNotFoundError("nope"))
        )
        # ...but the email is already claimed by some OTHER, unrelated uid.
        other_uid = "some-other-28-char-console-uid"
        monkeypatch.setattr(
            firebase_auth,
            "get_user_by_email",
            lambda email, app=None: _fake_user_record(other_uid, email),
        )
        create_called = []
        monkeypatch.setattr(firebase_auth, "create_user", lambda **kw: create_called.append(kw))
        monkeypatch.setattr(
            firebase_auth, "generate_password_reset_link", lambda *a, **kw: pytest.fail("must not be called")
        )

        ok = _seed_firebase_real_users([_identity(email="admin@example.com")], "acme-1234")

        assert ok is False
        assert create_called == []
        err = capsys.readouterr().err
        assert other_uid in err
        assert "Refusing to proceed" in err


class TestSeedFirebaseRealUsersRaceConditions:
    def test_create_racing_with_another_process_is_reported_not_raised(self, monkeypatch, capsys):
        monkeypatch.setattr(
            firebase_auth, "get_user", lambda uid, app=None: (_ for _ in ()).throw(firebase_auth.UserNotFoundError("nope"))
        )
        monkeypatch.setattr(
            firebase_auth,
            "get_user_by_email",
            lambda email, app=None: (_ for _ in ()).throw(firebase_auth.UserNotFoundError("nope")),
        )

        def fake_create_user(**kwargs):
            raise firebase_auth.UidAlreadyExistsError("raced", None, None)

        monkeypatch.setattr(firebase_auth, "create_user", fake_create_user)
        monkeypatch.setattr(
            firebase_auth, "generate_password_reset_link", lambda *a, **kw: pytest.fail("must not be called")
        )

        ok = _seed_firebase_real_users([_identity()], "acme-1234")

        assert ok is False
        err = capsys.readouterr().err
        assert "could not create" in err


class TestSeedFirebaseRealUsersMultipleIdentities:
    def test_one_bad_identity_does_not_block_provisioning_the_other(self, monkeypatch, capsys):
        admin_identity = _identity(uid=ADMIN_UID, email="admin@example.com")
        manager_identity = _identity(uid=MANAGER_UID, email="manager@example.com")

        def fake_get_user(uid, app=None):
            if uid == str(ADMIN_UID):
                # matches -> fine, idempotent no-op
                return _fake_user_record(str(ADMIN_UID), "admin@example.com")
            raise firebase_auth.UserNotFoundError("nope")

        monkeypatch.setattr(firebase_auth, "get_user", fake_get_user)
        monkeypatch.setattr(
            firebase_auth,
            "get_user_by_email",
            lambda email, app=None: (_ for _ in ()).throw(firebase_auth.UserNotFoundError("nope")),
        )
        create_calls = []

        def fake_create_user(**kwargs):
            create_calls.append(kwargs)
            return _fake_user_record(kwargs["uid"], kwargs["email"])

        monkeypatch.setattr(firebase_auth, "create_user", fake_create_user)
        monkeypatch.setattr(
            firebase_auth, "generate_password_reset_link", lambda email, app=None: f"https://example.test/reset/{email}"
        )

        ok = _seed_firebase_real_users([admin_identity, manager_identity], "acme-1234")

        assert ok is True
        assert len(create_calls) == 1
        assert create_calls[0]["uid"] == str(MANAGER_UID)
