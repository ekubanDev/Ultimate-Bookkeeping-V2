# Container image for the FastAPI backend, deployed to Cloud Run.
#
# Build context is apps/api (see .github/workflows/deploy.yml) — this image
# deliberately contains only the API. The outlet PWA is static assets served
# by Firebase Hosting, which rewrites /api/** here (see the root
# firebase.json); the two are same-origin to the browser but separately
# deployed artifacts.
#
# Migrations are NOT run from this image's entrypoint. `alembic upgrade head`
# is an explicit CD step that must complete before the new revision serves
# traffic (see README and the deploy workflow) — running it at container
# start would race every instance Cloud Run spins up against every other one.

# 3.11 to match .github/workflows/ci.yml's setup-python version, NOT the
# newest available: CI is the only thing that actually verifies this code, so
# the deployed runtime should be the runtime the test suite ran on. (Local
# venvs are on 3.12 and pass too — pyproject allows >=3.11 — but "passes
# locally" isn't the gate.) If CI is bumped, bump this in the same commit.
FROM python:3.11-slim

# PYTHONUNBUFFERED: Cloud Logging reads stdout/stderr line by line, so an
# unflushed buffer means logs arrive late or, on a crash, not at all — which
# is precisely when they matter.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# alembic/ and alembic.ini ship in the image so the migration CD step runs
# `alembic upgrade head` from this same artifact — migrations and the code
# they migrate for are then guaranteed to be one build rather than two
# checkouts that could drift.
COPY pyproject.toml ./
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

# Installs the runtime dependencies declared in pyproject.toml — deliberately
# not the [dev] extra, so pytest/httpx/aiosqlite stay out of the deployed
# image.
RUN pip install --upgrade pip && pip install .

# Non-root. Cloud Run does not require it, but nothing here needs root
# either, and a container that cannot write to its own filesystem is one
# fewer thing to reason about if the API is ever compromised.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /srv
USER appuser

# Cloud Run injects PORT and expects the container to listen on it; 8080 is
# the documented default for a local `docker run` without it.
ENV PORT=8080
EXPOSE 8080

# Single uvicorn worker per container by design: the app is async, and Cloud
# Run scales by adding containers rather than processes. Multiple workers here
# would multiply the Cloud SQL connection pool (see app/db.py's pool_size
# note) by the worker count against a fixed per-instance connection ceiling.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
