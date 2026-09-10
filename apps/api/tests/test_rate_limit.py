"""Rate limiting (Nana's medium finding) — app/rate_limit.py.

The limiter is disabled for the whole test session by default
(RATE_LIMIT_ENABLED=false, set in tests/conftest.py before app.main is ever
imported) so none of the other 60-odd tests in this suite gets throttled.
This module is the one place that flips it back on, for exactly the
duration of each test here, to exercise the real 429 behavior against the
real WRITE_RATE_LIMIT constant — then restores the disabled default.
"""
from __future__ import annotations

import pytest_asyncio

from app.rate_limit import WRITE_RATE_LIMIT, limiter, rate_limit_key


def test_rate_limiter_is_disabled_by_default_for_the_test_session():
    """Explicit guard for the "bypassable in tests" requirement — if this
    ever flips to True by accident (e.g. the conftest env-var seam breaks),
    every other test in the suite would start silently consuming rate-limit
    budget instead of failing loudly, so assert it directly."""
    assert limiter.enabled is False


@pytest_asyncio.fixture
async def rate_limited(client):
    """Enables the real limiter for one test, with a clean counter state,
    then restores the disabled-by-default posture other tests rely on."""
    limiter.reset()
    limiter.enabled = True
    try:
        yield client
    finally:
        limiter.enabled = False
        limiter.reset()


def _write_limit_count() -> int:
    # WRITE_RATE_LIMIT is a "<count>/<period>" string, e.g. "30/minute".
    return int(WRITE_RATE_LIMIT.split("/", 1)[0])


async def test_burst_past_write_limit_returns_429_retryable_envelope(rate_limited):
    """A burst of POST /expenses (one of the offline-eligible write
    endpoints, WRITE_RATE_LIMIT) past the configured count in the same
    window must return the standard error envelope with code RATE_LIMITED,
    HTTP 429, and retryable=True — the offline queue re-queues/retries on
    `retryable`, and a rate-limited write must never surface to the cashier
    as a failed sale."""
    client = rate_limited
    seed = client.seed
    limit = _write_limit_count()

    responses = []
    for i in range(limit + 1):
        resp = await client.post(
            "/api/v1/expenses",
            json={
                "client_id": f"rl-burst-{i}",
                "outlet_id": str(seed["outlet_id"]),
                "amount": "1.00",
                "category": "test",
            },
        )
        responses.append(resp)

    # Every request up to (and including) the configured count succeeds...
    for resp in responses[:limit]:
        assert resp.status_code == 201, resp.text

    # ...and the one that pushes past it is rejected with the standard
    # envelope, not slowapi's default `{"error": "Rate limit exceeded..."}`.
    throttled = responses[limit]
    assert throttled.status_code == 429, throttled.text
    body = throttled.json()
    assert body["error"]["code"] == "RATE_LIMITED"
    assert body["error"]["retryable"] is True
    assert "message" in body["error"]


class _FakeState:
    def __init__(self, actor_id: str | None = None):
        if actor_id is not None:
            self.actor_id = actor_id


class _FakeClient:
    def __init__(self, host: str):
        self.host = host


class _FakeRequest:
    """Minimal stand-in for starlette.Request — `rate_limit_key` (and
    `get_remote_address`, which it falls back to) only ever reads
    `request.state.actor_id` and `request.client.host`."""

    def __init__(self, *, actor_id: str | None = None, host: str = "10.0.0.5"):
        self.state = _FakeState(actor_id)
        self.client = _FakeClient(host)


def test_rate_limit_key_uses_authenticated_actor_id_when_present():
    """Two different authenticated accounts must not share one bucket —
    keying by `users.id` (set by app/auth.py's `get_current_user`), not
    just IP, matters for a shared-NAT outlet with multiple devices/
    accounts (task spec)."""
    request_a = _FakeRequest(actor_id="11111111-1111-1111-1111-111111111111", host="10.0.0.5")
    request_b = _FakeRequest(actor_id="22222222-2222-2222-2222-222222222222", host="10.0.0.5")

    key_a = rate_limit_key(request_a)
    key_b = rate_limit_key(request_b)

    assert key_a == "user:11111111-1111-1111-1111-111111111111"
    assert key_b == "user:22222222-2222-2222-2222-222222222222"
    assert key_a != key_b  # same IP, different accounts -> different buckets


def test_rate_limit_key_falls_back_to_client_ip_when_unauthenticated():
    """A request that never reached far enough into `get_current_user` to
    identify a user (bad/missing/expired token) has no `actor_id` yet —
    still bounded, by IP, per the task spec's fallback."""
    request = _FakeRequest(actor_id=None, host="41.66.200.10")

    assert rate_limit_key(request) == "ip:41.66.200.10"
