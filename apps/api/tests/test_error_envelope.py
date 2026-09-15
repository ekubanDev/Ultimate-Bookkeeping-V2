"""Every response carries the standard error envelope; docs are off by default.

Both behaviours were found missing during code review, on live code.

1. app/main.py registered handlers only for AppError, RateLimitExceeded and
   RequestValidationError. Anything else — a dead pool connection, a Cloud
   SQL failover, a genuine bug — fell through to Starlette's default and
   returned a bare `Internal Server Error` string. packages/offline-queue
   branches on `retryable` to decide whether a queued sale is retried or
   surfaced to the cashier as failed; an unparseable body means it can read
   neither.

2. FastAPI's default docs endpoints were live on the deployed service.
   Cloud Run must be --allow-unauthenticated for Firebase Hosting's rewrite
   to reach it, so /docs, /redoc and /openapi.json were internet-reachable
   and returned the full schema of all six endpoints.
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter
from httpx import ASGITransport, AsyncClient

from app.main import app, create_app


@pytest.fixture
def boom_route():
    """Mounts a route that raises an unhandled exception, then removes it."""
    router = APIRouter()

    @router.get("/__test__/boom")
    async def boom():  # pragma: no cover - the raise is the point
        raise RuntimeError("simulated database failure")

    app.include_router(router)
    yield
    app.routes[:] = [r for r in app.routes if getattr(r, "path", None) != "/__test__/boom"]


async def test_unhandled_exception_returns_the_standard_envelope(boom_route):
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/__test__/boom")

    assert resp.status_code == 500
    body = resp.json()
    assert set(body["error"]) >= {"code", "message", "retryable"}
    assert body["error"]["code"] == "INTERNAL_ERROR"


async def test_unhandled_exception_is_marked_retryable(boom_route):
    """The offline queue must re-queue, not discard, on a server-side fault.

    Safe because of the client_id contract: replaying an intent that did
    commit returns the original answer rather than writing twice
    (design.md §3.4).
    """
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/__test__/boom")

    assert resp.json()["error"]["retryable"] is True


async def test_unhandled_exception_does_not_leak_internals_to_the_client(boom_route):
    """The traceback belongs in the logs, not the response body."""
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/__test__/boom")

    text = resp.text
    assert "simulated database failure" not in text
    assert "RuntimeError" not in text
    assert "Traceback" not in text


def test_docs_are_disabled_by_default(monkeypatch):
    monkeypatch.delenv("ENABLE_API_DOCS", raising=False)
    fresh = create_app()
    assert fresh.docs_url is None
    assert fresh.redoc_url is None
    assert fresh.openapi_url is None


def test_docs_can_be_enabled_explicitly_for_local_development(monkeypatch):
    monkeypatch.setenv("ENABLE_API_DOCS", "true")
    fresh = create_app()
    assert fresh.docs_url == "/docs"
    assert fresh.openapi_url == "/openapi.json"


@pytest.mark.parametrize("value", ["", "false", "0", "no", "False "])
def test_only_an_explicit_affirmative_enables_docs(monkeypatch, value):
    """A stray or empty value must not publish the schema."""
    monkeypatch.setenv("ENABLE_API_DOCS", value)
    assert create_app().openapi_url is None
