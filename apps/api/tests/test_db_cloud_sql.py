"""Cloud SQL socket wiring — `app.db.cloud_sql_connect_args`.

Regression cover for a deploy failure that reached production infrastructure
before anything caught it. `app/db.py` builds the app's engine, and
`alembic/env.py` builds a SECOND, independent engine via
`async_engine_from_config`. The Cloud SQL socket path was applied to the
first and not the second, so the app connected fine while `alembic upgrade
head` fell back to asyncpg's default of TCP 127.0.0.1:5432 and died with
`ConnectionRefusedError` — an error naming neither sockets nor Cloud SQL,
from a code path no test or local run exercises (CLOUD_SQL_CONNECTION_NAME
is unset everywhere except Cloud Run).

These tests are cheap and structural on purpose: the real thing being
protected is "every engine that reaches the deployed database applies the
same connect args", which no amount of testing the app's engine alone would
have caught.
"""
from __future__ import annotations

import ast
import importlib
import os
from pathlib import Path

import pytest

import app.db


@pytest.fixture
def reloaded_db(monkeypatch):
    """Reload app.db with a given CLOUD_SQL_CONNECTION_NAME, then restore it.

    app.db reads the variable at import time (module-level constant), so the
    module has to be reloaded rather than just patching os.environ.
    """

    def _load(connection_name: str | None):
        if connection_name is None:
            monkeypatch.delenv("CLOUD_SQL_CONNECTION_NAME", raising=False)
        else:
            monkeypatch.setenv("CLOUD_SQL_CONNECTION_NAME", connection_name)
        return importlib.reload(app.db)

    yield _load
    # Leave the module in the state the rest of the suite expects.
    monkeypatch.delenv("CLOUD_SQL_CONNECTION_NAME", raising=False)
    importlib.reload(app.db)


def test_no_connect_args_when_not_on_cloud_run(reloaded_db):
    """Unset is the normal case — local dev and both CI database jobs. The
    engine must be built exactly as it was before Cloud SQL support existed.
    """
    db = reloaded_db(None)
    assert db.cloud_sql_connect_args() == {}


def test_socket_directory_when_connection_name_is_set(reloaded_db):
    db = reloaded_db("my-project:europe-west1:ubk-postgres")
    assert db.cloud_sql_connect_args() == {
        "host": "/cloudsql/my-project:europe-west1:ubk-postgres"
    }


def test_host_is_the_socket_directory_not_the_socket_file(reloaded_db):
    """asyncpg appends '/.s.PGSQL.5432' to a host beginning with '/' itself.
    Appending it here too yields a path that does not exist, and the
    resulting error looks identical to the socket not being mounted at all.
    """
    db = reloaded_db("p:r:i")
    host = db.cloud_sql_connect_args()["host"]
    assert host.startswith("/cloudsql/")
    assert not host.endswith(".s.PGSQL.5432")


def test_alembic_env_applies_the_same_connect_args():
    """The actual regression. alembic/env.py must pass connect_args into its
    own engine; it does not inherit app/db.py's. Asserted by parsing env.py
    rather than running a migration, so it holds without a live database —
    the condition being protected is structural, and the deployment where it
    mattered is exactly the one no test can reach.
    """
    env_py = Path(__file__).resolve().parents[1] / "alembic" / "env.py"
    tree = ast.parse(env_py.read_text())

    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "async_engine_from_config"
    ]
    assert calls, "alembic/env.py no longer builds an engine the expected way"

    for call in calls:
        kwargs = {kw.arg for kw in call.keywords}
        assert "connect_args" in kwargs, (
            "alembic/env.py builds an engine without connect_args — on Cloud "
            "Run this makes `alembic upgrade head` connect to TCP localhost "
            "instead of the Cloud SQL socket. Pass "
            "app.db.cloud_sql_connect_args()."
        )


def test_alembic_env_imports_the_shared_helper():
    """Re-deriving the socket path in env.py instead of importing it would
    pass the test above while reintroducing the two-sources-of-truth problem
    that caused the original failure.
    """
    env_py = Path(__file__).resolve().parents[1] / "alembic" / "env.py"
    source = env_py.read_text()
    assert "cloud_sql_connect_args" in source
    assert "/cloudsql/" not in source, (
        "alembic/env.py appears to build the socket path itself — import "
        "cloud_sql_connect_args from app.db instead, so there is one "
        "definition to keep correct."
    )
