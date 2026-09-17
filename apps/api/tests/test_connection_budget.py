"""The connection budget is one inequality split across two files.

Postgres refuses connections past `max_connections`. On Cloud SQL that is a
property of the machine tier, not something this app sets — db-f1-micro
allows 25. Cloud Run multiplies whatever pool each container holds by however
many containers it runs. So:

    max-instances x (pool_size + max_overflow)  <=  usable connections

The left half lives in .github/workflows/deploy.yml. The right half lives in
apps/api/app/db.py. Nothing connected them, and the inequality was violated
by nearly a factor of three — max-instances 10 x (5 + 2) = 70 against a
ceiling of 25 — while db.py's own comment claimed the pool "keeps total
connections under that ceiling as instance count grows".

It was invisible because it only bites under load: Postgres starts refusing
connections before Cloud Run looks busy, so the symptom is random 5xx on
sales, which reads as an application fault rather than a capacity limit. The
live instance was sitting at 9 connections when this was found.

This is the sixth bug in this codebase with the same shape — one fact stated
in two places with nothing checking they agree (the others: a second
SQLAlchemy engine without connect_args, a token provider registered in an
effect, a service worker precaching without claiming clients, service-worker
regexes matched against paths but tested against URLs, and a global
client_id lookup under per-tenant authorization). The instances get fixed
individually; this test exists because the CLASS is only killed by making
the two halves meet somewhere.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.db import (
    CLOUD_SQL_MAX_CONNECTIONS,
    CONNECTIONS_PER_CONTAINER,
    MAX_OVERFLOW,
    POOL_SIZE,
    RESERVED_CONNECTIONS,
)

DEPLOY_YML = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "deploy.yml"


def _deployed_max_instances() -> int:
    """Read --max-instances out of the Cloud Run deploy step."""
    source = DEPLOY_YML.read_text()
    matches = re.findall(r"^\s*--max-instances\s+(\d+)", source, re.M)
    assert matches, (
        "--max-instances not found in deploy.yml — if the flag was renamed or "
        "removed, this budget is no longer enforced and this test must be updated "
        "rather than deleted."
    )
    assert len(matches) == 1, f"expected one --max-instances, found {matches}"
    return int(matches[0])


def test_worst_case_connections_fit_under_the_postgres_ceiling():
    max_instances = _deployed_max_instances()
    worst_case = max_instances * CONNECTIONS_PER_CONTAINER
    budget = CLOUD_SQL_MAX_CONNECTIONS - RESERVED_CONNECTIONS

    assert worst_case <= budget, (
        f"connection budget exceeded: {max_instances} instances x "
        f"{CONNECTIONS_PER_CONTAINER} per container = {worst_case}, but only "
        f"{budget} are available ({CLOUD_SQL_MAX_CONNECTIONS} on the tier minus "
        f"{RESERVED_CONNECTIONS} reserved).\n\n"
        "Postgres will refuse connections under load and it will look like "
        "random 5xx on sales. Either lower --max-instances in "
        ".github/workflows/deploy.yml, lower POOL_SIZE/MAX_OVERFLOW in "
        "app/db.py, or raise the Cloud SQL tier AND update "
        "CLOUD_SQL_MAX_CONNECTIONS to match the new tier's real limit."
    )


def test_the_budget_is_not_trivially_satisfied():
    """Guard against someone 'fixing' a failure by zeroing the inputs."""
    assert POOL_SIZE >= 1
    assert MAX_OVERFLOW >= 0
    assert CONNECTIONS_PER_CONTAINER == POOL_SIZE + MAX_OVERFLOW
    assert _deployed_max_instances() >= 1
    assert RESERVED_CONNECTIONS > 0, (
        "some connections must stay free for the migration job, the Cloud SQL "
        "Auth Proxy and manual psql — a budget that allocates all 25 to the "
        "service locks you out of your own database during an incident"
    )


def test_reserved_headroom_covers_the_migration_job_and_an_operator():
    """The deploy runs `alembic upgrade head` as a Cloud Run Job while the
    service is still serving. That job needs a connection, and so does whoever
    is watching it."""
    assert RESERVED_CONNECTIONS >= 4, (
        "headroom too thin: Postgres reserves ~3 for superusers, the migration "
        "job needs one (NullPool, see alembic/env.py), and an operator debugging "
        "through the Cloud SQL Auth Proxy needs at least one more"
    )


def test_deploy_yml_has_no_comment_inside_a_continued_shell_command():
    """A `#` line inside a backslash-continued command truncates it.

    Not hypothetical: this was introduced while documenting --max-instances
    and caught before merge. bash joins the continuation, treats `#` as the
    start of a comment, and the command ENDS there — the remaining flags
    become a separate command that fails with "command not found". For the
    Cloud Run deploy step specifically that would have silently dropped
    --allow-unauthenticated and taken the API offline, since Firebase
    Hosting's rewrite cannot reach a private service.

    Explanatory notes belong above the step, in YAML comment space.
    """
    offenders: list[tuple[int, str]] = []
    previous_continues = False
    for lineno, raw in enumerate(DEPLOY_YML.read_text().splitlines(), start=1):
        stripped = raw.strip()
        if previous_continues and stripped.startswith("#"):
            offenders.append((lineno, stripped[:60]))
        previous_continues = stripped.endswith("\\")

    assert not offenders, (
        "comment inside a backslash-continued shell command — this truncates it:\n"
        + "\n".join(f"  deploy.yml:{n}: {t}" for n, t in offenders)
    )
