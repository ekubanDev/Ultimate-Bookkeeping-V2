"""Tests for app/auth.py's real verification flow and GET /api/v1/me.

Unlike the rest of the suite (which overrides `get_current_user` wholesale,
see tests/conftest.py's `client` fixture), these tests leave `get_current_user`
wired to its real implementation and monkeypatch `verify_token` — the one
seam that talks to firebase_admin — so the actual uid -> users-table ->
CurrentUser path is exercised end-to-end without ever touching firebase_admin
or requiring GOOGLE_APPLICATION_CREDENTIALS/network access.
"""
from __future__ import annotations

import uuid

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app import auth as auth_module
from app.db import get_db
from app.main import app


def test_importing_auth_does_not_initialize_firebase():
    """Import-time must never touch firebase_admin/credentials — the Admin
    SDK is only ever initialized lazily, inside verify_token's call to
    `_ensure_firebase_app()`. None of the other tests in this suite exercise
    the real `verify_token` (they either override `get_current_user` or
    monkeypatch `verify_token` directly), so this guard staying `None`
    confirms the whole run never needed real Firebase credentials/network.
    """
    assert auth_module._firebase_app is None


@pytest_asyncio.fixture
async def real_auth_client(session_factory, seed):
    """Like conftest's `client` fixture, but does NOT override
    `get_current_user` — only `get_db` — so `verify_token` (patched per-test
    below) actually drives the real users-table lookup.
    """

    async def override_get_db():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac.seed = seed  # type: ignore[attr-defined]
        yield ac

    app.dependency_overrides.clear()


async def test_me_happy_path_admin(real_auth_client, monkeypatch):
    seed = real_auth_client.seed
    monkeypatch.setattr(auth_module, "verify_token", lambda token: str(seed["admin_id"]))

    resp = await real_auth_client.get("/api/v1/me", headers={"Authorization": "Bearer whatever-token"})

    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "id": str(seed["admin_id"]),
        "role": "admin",
        "outlet_id": None,
        "display_name": "Admin",
    }


async def test_me_happy_path_outlet_manager(real_auth_client, monkeypatch):
    seed = real_auth_client.seed
    monkeypatch.setattr(auth_module, "verify_token", lambda token: str(seed["manager_id"]))

    resp = await real_auth_client.get("/api/v1/me", headers={"Authorization": "Bearer whatever-token"})

    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "id": str(seed["manager_id"]),
        "role": "outlet_manager",
        "outlet_id": str(seed["outlet_id"]),
        "display_name": "Manager",
    }


async def test_me_missing_authorization_header_is_401(real_auth_client):
    resp = await real_auth_client.get("/api/v1/me")

    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "UNAUTHENTICATED"
    assert body["error"]["retryable"] is False


async def test_me_malformed_authorization_header_is_401(real_auth_client):
    resp = await real_auth_client.get("/api/v1/me", headers={"Authorization": "Basic whatever"})

    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "UNAUTHENTICATED"
    assert body["error"]["retryable"] is False


async def test_me_garbage_token_verify_token_raises_is_401(real_auth_client, monkeypatch):
    def _raise(token: str) -> str:
        raise auth_module.TokenVerificationError("invalid signature")

    monkeypatch.setattr(auth_module, "verify_token", _raise)

    resp = await real_auth_client.get("/api/v1/me", headers={"Authorization": "Bearer garbage"})

    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "UNAUTHENTICATED"
    assert body["error"]["retryable"] is False


async def test_me_unknown_uid_is_403_user_not_provisioned(real_auth_client, monkeypatch):
    unknown_uid = str(uuid.uuid4())
    monkeypatch.setattr(auth_module, "verify_token", lambda token: unknown_uid)

    resp = await real_auth_client.get("/api/v1/me", headers={"Authorization": "Bearer whatever-token"})

    assert resp.status_code == 403
    body = resp.json()
    assert body["error"]["code"] == "USER_NOT_PROVISIONED"
    assert body["error"]["retryable"] is False


async def test_me_non_uuid_uid_is_403_user_not_provisioned(real_auth_client, monkeypatch):
    """A verified token whose uid isn't even a well-formed UUID can't match
    any users row either — same "verified but unprovisioned" outcome as a
    well-formed-but-unknown uid, not a separate error class.
    """
    monkeypatch.setattr(auth_module, "verify_token", lambda token: "not-a-uuid")

    resp = await real_auth_client.get("/api/v1/me", headers={"Authorization": "Bearer whatever-token"})

    assert resp.status_code == 403
    body = resp.json()
    assert body["error"]["code"] == "USER_NOT_PROVISIONED"
