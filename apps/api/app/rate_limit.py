"""Rate limiting for the FastAPI backend.

Nana's security review (medium finding): no rate limiting anywhere — every
financial write endpoint (POST /sales, POST /stock/adjustments, POST
/expenses) was open to volumetric abuse from any single valid account, with
no bound at all on unauthenticated traffic either.

Library choice: `slowapi` (a thin FastAPI/Starlette wrapper around the
`limits` library). Justification for not building something bespoke: it's
ASGI-native, ships an in-process memory backend out of the box (this app has
no Redis/cache tier today, and standing one up purely for rate-limit
counters isn't worth it for the current MVP scale — revisit if this becomes
a multi-process deployment, since in-memory counters don't share state
across processes/workers), and its per-route `@limiter.limit(...)` decorator
accepts an arbitrary `key_func`, which is what makes the "key by user, else
IP" requirement below straightforward instead of a bespoke middleware.

Key strategy (task spec): key by the AUTHENTICATED user id where available,
falling back to client IP for unauthenticated requests. This matters for
West African outlet deployments specifically: several cashier devices at one
outlet often sit behind a single shared connection/NAT IP, so IP-only keying
would let one busy till's traffic starve the others sharing that IP. Keying
by `users.id` once a request is authenticated avoids that; requests that
never get past authentication (bad/missing/expired token) have no user id
yet, so they fall back to IP — still a meaningful bound on anonymous floods,
including credential-probing attempts against a single IP.

`request.state.actor_id` is set as a side effect of `get_current_user`
(app/auth.py) the moment a `users` row is found for the token's uid — even
for a *disabled* account (Nana's revocation finding) — so a disabled-account
retry storm is bucketed per-account rather than dog-piling onto a shared IP
bucket too. It is never derived from unverified token claims, only from the
`users` row `get_current_user` already authenticates against.

Enable/disable (env flag, task spec): controlled by `RATE_LIMIT_ENABLED`.
Defaults to enabled — production must never set this to "false"; there is no
other code path that disables the limiter for a live deployment. The test
suite is the one place that opts out, by setting `RATE_LIMIT_ENABLED=false`
in the environment *before* `app.main` (and therefore this module) is first
imported — see tests/conftest.py. One test (tests/test_rate_limit.py)
flips `limiter.enabled` back to `True` for its own duration, to exercise the
real 429 behavior, then restores it — a "trivially bypassable" seam per the
task spec, but one that can never be reached from production config (no env
var is read at request time; `RATE_LIMIT_ENABLED` is only ever consulted
once, at import).
"""
from __future__ import annotations

import os

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

# --- Named limit constants -------------------------------------------------
# Yaw tunes these here; no need to hunt through router decorators.
# Syntax is the `limits` library's "<count>/<period>" strings.

# WRITE_RATE_LIMIT — POST /sales, POST /stock/adjustments, POST /expenses.
#
# Reasoning: a genuinely busy single-till cashier (scan items, take payment,
# hand over change/print receipt) tops out somewhere around one completed
# sale every 15-20 seconds even at peak — call it ~3-4 transactions/minute
# sustained, generously. 30/minute per user is ~8x that realistic peak, which
# comfortably absorbs legitimate retries too (the offline queue in
# packages/offline-queue replays queued sales/adjustments/expenses on
# reconnect after a spotty connection, which can burst several writes in a
# few seconds) while still bounding a scripted/automated abuse burst from one
# account to a fraction of what unbounded access would allow.
WRITE_RATE_LIMIT = "30/minute"

# READ_RATE_LIMIT — GET /sales, GET /stock/levels, GET /products.
#
# Reasoning: these back a POS screen's catalog/stock refresh and paginated
# list views — bursty on reconnect (a device coming back online may refetch
# several of these in quick succession) but never a per-transaction hot loop
# the way a write is. 120/minute (2/sec) is generous enough that no
# legitimate polling/pagination pattern should ever come close to it.
READ_RATE_LIMIT = "120/minute"

# AUTH_RATE_LIMIT — GET /me and any future auth-adjacent path.
#
# Reasoning: /me is called once at app bootstrap per device/session (it's
# how the outlet app learns its own outlet_id — app/routers/me.py), not in a
# per-transaction hot loop, so it's tightened deliberately relative to reads
# in general: it blunts a credential/account-probing flood without punishing
# normal bootstrap traffic.
AUTH_RATE_LIMIT = "20/minute"


def _env_enabled(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


# Read exactly once, at import time (never at request time) — production
# config has no way to toggle this per-request. Defaults ON; must be
# explicitly turned off (tests/conftest.py) to be disabled at all.
RATE_LIMIT_ENABLED_DEFAULT = _env_enabled("RATE_LIMIT_ENABLED", True)


def rate_limit_key(request: Request) -> str:
    """The authenticated user's id if `get_current_user` (app/auth.py)
    reached far enough to identify one, else the client's remote address.
    """
    actor_id = getattr(request.state, "actor_id", None)
    if actor_id:
        return f"user:{actor_id}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(key_func=rate_limit_key, enabled=RATE_LIMIT_ENABLED_DEFAULT)
