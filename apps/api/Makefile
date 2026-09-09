# Convenience targets for local development. Every target assumes:
#   - a Python virtualenv is active (or `.venv` exists) with the package
#     installed: `pip install -e ".[dev]"`
#   - DATABASE_URL (and, if verifying real auth, FIREBASE_* vars) are set
#     in your environment — see .env.example. Nothing here loads `.env`
#     for you.
# See README.md for the full walkthrough. `uvicorn app.main:app --reload
# --port 8000` (what `make run` invokes) is the one command that actually
# matters if you'd rather not use `make` at all.

.PHONY: install migrate seed run test test-postgres

install:
	pip install -e ".[dev]"

migrate:
	alembic upgrade head

# Usage: make seed ADMIN_UID=... MANAGER_UID=...  (both optional — omit to
# generate fresh random UUIDs; see scripts/seed_dev.py)
seed:
	python -m scripts.seed_dev $(if $(ADMIN_UID),--admin-uid $(ADMIN_UID)) $(if $(MANAGER_UID),--manager-uid $(MANAGER_UID))

run:
	uvicorn app.main:app --reload --port 8000

test:
	pytest -v

# Same suite, against Postgres instead of the default in-memory SQLite —
# requires DATABASE_URL to point at a real (local/test) Postgres database.
test-postgres:
	pytest -v
