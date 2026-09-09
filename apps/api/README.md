# Ultimate Bookkeeping API (apps/api)

FastAPI backend for the Outlet app (`apps/outlet`) and, eventually, the
admin console. See the repo root for the overall project layout and
`/CLAUDE.md` for the constraints this service operates under (offline-write
contract, money-as-strings, `client_id` idempotency, etc.) — this file is
just about getting the API itself running locally.

Everything below was run and verified in a Linux sandbox (Ubuntu 24.04,
Python 3.11.15, local Postgres 16, Node 22 + the `firebase-tools` CLI) as
part of building this document. Where something couldn't be verified in
that sandbox (mainly: a real Firebase project), it's called out explicitly
below instead of asserted.

## Prerequisites

- Python 3.11+
- A Postgres 16 instance you can create a database on (local install,
  Docker, whatever). SQLite (via `aiosqlite`) is used automatically for
  `pytest` with no setup, but the app itself and Alembic migrations target
  Postgres only — see `app/db.py` and `alembic/env.py`.
- For real authentication: either the **Firebase Auth emulator** (no GCP
  project needed — recommended for local dev, see below) or a real Firebase
  project + a service-account key.

## Setup

```bash
cd apps/api
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # then edit .env — see the comments in that file
```

Nothing loads `.env` automatically (no `python-dotenv` wiring in `app/` —
see `.env.example`'s header comment). Export the variables yourself, e.g.:

```bash
set -a; source .env; set +a
```

or configure Cursor's run/launch config to inject them, or just `export`
each one in your shell.

## Database: create it, then migrate

Create an empty local Postgres database and point `DATABASE_URL` at it
(asyncpg driver — this is what `app/db.py` and `alembic/env.py` both read):

```bash
createdb ultimate_bookkeeping   # or: psql -c "CREATE DATABASE ultimate_bookkeeping"
export DATABASE_URL=postgresql+asyncpg://<user>:<password>@localhost:5432/ultimate_bookkeeping
alembic upgrade head
```

Verified in the sandbox exactly as written above (against a freshly
created `ultimate_bookkeeping` database owned by a local `ubk` role):

```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> 6cca266108dc, initial schema
```

## Seed data

A freshly-migrated database has no `users` row and an empty catalog — every
authenticated request will 403 `USER_NOT_PROVISIONED` and the POS has
nothing to sell. `scripts/seed_dev.py` fixes both:

```bash
python -m scripts.seed_dev --admin-uid <uuid> --manager-uid <uuid>
# or: SEED_ADMIN_UID=<uuid> SEED_MANAGER_UID=<uuid> python -m scripts.seed_dev
# or, with no uids at all — the script generates and prints fresh ones:
python -m scripts.seed_dev
```

This creates one coherent tenant: an admin, an outlet that admin owns, an
outlet_manager assigned to it, an 8-item Ghanaian-retail product catalog
(Milo, sachet water, Indomie, Frytol, Tampico juice, rice, Peak milk,
Voltic water) with GHS prices, and matching `stock_levels` rows — two of
them deliberately below their `min_stock` (to exercise the low-stock cue),
and one product (Tampico Juice) with `min_stock = NULL` (to exercise the
low-stock cue's null-handling, since not every product has a configured
reorder threshold). It's idempotent — re-running it updates the same rows
instead of duplicating them (verified: ran it twice against the same
database, row counts were identical both times).

**The critical detail** (see the PROVISIONING INVARIANT note in
`app/auth.py`): `users.id` must equal the Firebase uid the user actually
signs in with. The `--admin-uid`/`--manager-uid` you pass become both.
If you're using the Firebase Auth emulator (below), the script *also*
creates matching emulator users with `uid=` set explicitly, so the two
sides cannot drift — see "Firebase Auth emulator" below for the full
seed → sign-in flow. If you're pointed at a real Firebase project instead,
you must create matching users there yourself, with the *same* UUIDs
passed as `uid=` explicitly to `create_user()` (never the Console UI, never
`create_user()` with no `uid=` — that produces a 28-char auto-generated uid
that can never parse as a UUID, hence can never match the `users` row —
see `app/auth.py` for the full explanation).

`scripts/seed_dev.py` refuses to run against anything that looks like a
production database (a database name containing `prod`, or a non-loopback
host without `SEED_ALLOW_NONLOCAL_HOST=1`) — verified both refusals fire
correctly. This is a heuristic safety net, not a substitute for pointing
`DATABASE_URL` at a real local database in the first place.

## Firebase Auth emulator (local dev, no GCP project needed)

`app/auth.py` verifies every request's bearer token via
`firebase_admin.auth.verify_id_token` and fails closed (401) on anything it
can't verify — there is no bypass. For local development without a real
Firebase project or service-account key, set:

```
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIREBASE_PROJECT_ID=ultimate-bookkeeping-dev   # any string; not a real GCP project
```

`firebase_admin`/`google-auth` honour `FIREBASE_AUTH_EMULATOR_HOST` natively
— nothing in this codebase branches on it beyond a startup log line (see
`app/auth.py`'s `_ensure_firebase_app` docstring for exactly how/why this
works with zero real credentials). **This is a local-development-only
affordance and must never be set in a deployed environment** — a process
with this variable set accepts any locally-forged, unsigned token.

Run the emulator (requires the `firebase-tools` CLI: `npm install -g
firebase-tools` — no `firebase login` / Google account needed just to run
the emulator). `apps/api/firebase.json` + `apps/api/.firebaserc` are already
checked in with a matching config (auth emulator on port 9099, default
project `ultimate-bookkeeping-dev` — not a real GCP project, just an id the
emulator and `FIREBASE_PROJECT_ID` need to agree on), so this just works
from `apps/api`:

```bash
firebase emulators:start --only auth
```

Verified end to end in the sandbox: started the emulator this way, ran
`scripts/seed_dev.py` with `FIREBASE_AUTH_EMULATOR_HOST`/`FIREBASE_PROJECT_ID`
set (it created two emulator users, `admin@ultimatebookkeeping.dev` and
`manager@ultimatebookkeeping.dev`, password `DevPassword123!`), signed in
as the admin via the emulator's REST API to get a real ID token, and hit
the running API with it (see "Verification" below for exact output).

## Running the server

```bash
uvicorn app.main:app --reload --port 8000
```

Port 8000 to match the Vite dev-server proxy Kojo is configuring on the
outlet app side. Also available as `make run` (see `Makefile` — `make
install` / `make migrate` / `make seed` / `make run` / `make test` /
`make test-postgres` wrap the same commands documented here; there is no
functionality in the Makefile that isn't also just a plain command above).

## Running the tests

Against the default in-memory SQLite (fast, no setup — this is what CI's
`api-tests` job runs):

```bash
pytest
```

Against Postgres (this is what CI's `api-tests-postgres` job runs — it's
the job that actually protects `NUMERIC(12,2)` precision, the partial
unique index on `stock_movements`, and FK enforcement; SQLite silently
tolerates things Postgres won't — see `tests/conftest.py`'s comments):

```bash
DATABASE_URL=postgresql+asyncpg://<user>:<password>@localhost:5432/<a_test_db> pytest
```

Use a dedicated test database, not the one you seeded above — the Postgres
test run creates/drops the whole `public` schema around every test.

Both verified in the sandbox:

```
$ pytest -q
........................................................................ [ 68%]
.................................                                        [100%]
105 passed in 4.43s

$ DATABASE_URL=postgresql+asyncpg://ubk:ubk@localhost:5432/ultimate_bookkeeping_ci pytest -q
........................s............................................... [ 68%]
.................................                                        [100%]
104 passed, 1 skipped in 13.70s
```

(The single skip is pre-existing and unrelated to anything in this change —
present before and after.)

Also verified the CI-equivalent Alembic round-trip check (fresh database,
`alembic upgrade head` then `alembic check`) reports no drift.

## Verification performed for this change (exact commands + output)

All of the following ran successfully in this sandbox, in order, against a
freshly created local Postgres database (`ultimate_bookkeeping`, owned by a
local `ubk` role) and a locally-running `firebase emulators:start --only
auth`:

1. `alembic upgrade head` — applied cleanly (output above).
2. `python -m scripts.seed_dev --admin-uid 11111111-1111-4111-8111-111111111111 --manager-uid 22222222-2222-4222-8222-222222222222` (no emulator vars set) — created the 2 users, 1 outlet, 8 products, 8 stock_levels rows; re-ran it and row counts were unchanged.
3. Confirmed the safety guard refuses a DB name containing `prod` and a non-loopback host, each with exit code 1 and no writes attempted.
4. Re-ran the same seed command with `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` and `FIREBASE_PROJECT_ID=ultimate-bookkeeping-dev` set — it additionally created two matching emulator users (uid-for-uid with the DB rows).
5. Started the server: `uvicorn app.main:app --port 8000` (same env as step 4, plus `DATABASE_URL`). Startup log included the expected loud emulator warning:
   ```
   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 is set: this process will accept Firebase Auth EMULATOR tokens (unsigned, any uid) instead of verifying real Firebase ID tokens. This is a local-development-only affordance (see app/auth.py, apps/api/.env.example) and must NEVER be set in a deployed/production environment.
   ```
6. Signed in as `admin@ultimatebookkeeping.dev` / `DevPassword123!` via the emulator's `accounts:signInWithPassword` REST endpoint to get a real ID token, then:
   ```
   $ curl http://127.0.0.1:8000/api/v1/me -H "Authorization: Bearer $TOKEN"
   {"id":"11111111-1111-4111-8111-111111111111","role":"admin","outlet_id":null,"display_name":"Ama Owusu (Admin)"}
   HTTP 200

   $ curl "http://127.0.0.1:8000/api/v1/products?outlet_id=dbd2dad0-e100-549e-9a49-6940e17269da" -H "Authorization: Bearer $TOKEN"
   [{"id":"...","sku":"FRYTOL-1L","name":"Frytol Vegetable Oil 1L","unit_price":"38.00","min_stock":15}, ...8 products total, including {"sku":"TAMPICO-500ML", ..., "min_stock":null}]
   HTTP 200
   ```
7. Repeated as the seeded outlet_manager (`manager@ultimatebookkeeping.dev`) — `GET /api/v1/me` returned the manager's own `outlet_id` (never client-supplied), and `GET /api/v1/stock/levels` (no `outlet_id` param needed for a manager) returned all 8 stock rows correctly scoped to their outlet.
8. Confirmed the fail-closed path is unaffected: a garbage bearer token and a missing `Authorization` header both returned `401 UNAUTHENTICATED` exactly as before.
9. Full `pytest` suite green on both SQLite and Postgres (output above), plus the Alembic round-trip check.

### What was **not** verified (needs a real environment)

- **A real Firebase project.** Everything above uses the Auth emulator —
  I did not verify sign-in against a real Firebase project, a real
  service-account key via `GOOGLE_APPLICATION_CREDENTIALS`, or the "no
  `FIREBASE_AUTH_EMULATOR_HOST`, real ADC" code path beyond confirming it
  still fails closed with no credentials configured (which it does — see
  `_ensure_firebase_app`'s docstring in `app/auth.py`, and the "fails
  closed as expected" checks run during development of this change).
- **The outlet app (`apps/outlet`) actually talking to this server** — that
  is Kojo's side of this work (Vite proxy → `localhost:8000`); I only
  exercised the API directly with `curl`, not through the frontend or the
  offline-queue.
- **Anything Windows-specific.** `make`/`uvicorn --reload` were only
  exercised on Linux; Cursor on Windows would need WSL or the plain
  `uvicorn app.main:app --reload --port 8000` command (documented above,
  works without `make`).
- **Production deploy configuration** (real `DATABASE_URL`, secrets
  management, `GOOGLE_APPLICATION_CREDENTIALS` provisioning in a deployed
  environment) — out of scope here; that's Yaw's territory.

## What you still need to bring

- A real Firebase project (or continued use of the emulator) — this repo
  contains no Firebase project of its own.
- If not using the emulator: a service-account key
  (`GOOGLE_APPLICATION_CREDENTIALS`) for that project, and real Firebase
  users provisioned with `uid=` explicitly set to match the `users.id`
  UUIDs you seed (see the PROVISIONING INVARIANT note in `app/auth.py` —
  there is no provisioning tooling for this in the outlet app; that
  belongs in `/apps/admin` per `/CLAUDE.md`).
- A Postgres instance for anything beyond quick local exploration on
  SQLite (the app never runs on SQLite outside the test suite).
