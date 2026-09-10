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
the script can provision it for you too, with the same uid-for-uid
guarantee and a set of guardrails a manual "create a user with the right
uid" step doesn't have — see "Real Firebase project" below. (It can also
still be done by hand instead, exactly as before: create matching users
yourself, with the *same* UUIDs passed as `uid=` explicitly to
`create_user()` — never the Console UI, never `create_user()` with no
`uid=` — that produces a 28-char auto-generated uid that can never parse
as a UUID, hence can never match the `users` row — see `app/auth.py` for
the full explanation.)

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

## Real Firebase project

Everything above (and CI) uses the Auth emulator — no GCP project needed.
Once you have a real GCP/Firebase project (staging, or production), here is
the end-to-end path, split into what happens in the Firebase console, what
the API needs, and what `scripts/seed_dev.py` can now do for you instead of
that step being an entirely manual, easy-to-get-wrong one.

### 1. In the Firebase console

- **Enable the Email/Password sign-in provider**: Authentication -> Sign-in
  method -> Email/Password -> Enable. Without this, `create_user()` /
  password-reset links and actual sign-in with a password all fail —
  this project ships no other sign-in method.
- **Register a Web app** (Project settings -> General -> "Your apps" -> Add
  app -> Web) to get the client-side config values. Those are consumed by
  the *outlet app*, not this API — see `apps/outlet/.env.example`'s
  `VITE_FIREBASE_*` variables (combination A in that file) for exactly
  which values and where they go; not duplicated here to avoid the two
  copies drifting.
- **Generate a service-account key** (Project settings -> Service accounts
  -> Generate new private key) for the Admin SDK this API process uses
  server-side (see `.env.example`'s Firebase Admin SDK section, mode 2).
  Never commit that JSON file.

### 2. Configure this API to verify real tokens

Per `.env.example` (mode 2): set `FIREBASE_PROJECT_ID` to the real project
id and `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of the
downloaded service-account key; leave `FIREBASE_AUTH_EMULATOR_HOST` unset.
`app/auth.py` needs no code change for this — it already verifies real
tokens via Application Default Credentials whenever the emulator variable
isn't set.

### 3. Provision the admin/outlet_manager accounts

This is the step that used to be entirely manual — "create a Firebase user
with this exact `uid=`" by hand — which is exactly the silent-lockout trap
the PROVISIONING INVARIANT note in `app/auth.py` warns about: get the uid
wrong (e.g. let the Console UI or a bare `create_user()` assign it) and the
account can *never* authenticate, indistinguishable to the end user from
"not provisioned yet", even after a `users` row exists.

`scripts/seed_dev.py` can now do this step for you, with the Admin SDK,
against the real project:

```bash
python -m scripts.seed_dev --admin-uid <uuid> --manager-uid <uuid> \
    --admin-email you@yourcompany.example --manager-email manager@yourcompany.example \
    --allow-real-firebase --real-firebase-project-id <your-real-project-id>
```

This writes real, externally-visible infrastructure, so it has guardrails
the emulator path doesn't need:

- **Explicit opt-in, every time.** Nothing above happens unless both
  `--allow-real-firebase` and `--real-firebase-project-id` are passed on
  the command line. `--real-firebase-project-id` is deliberately never
  read from `$FIREBASE_PROJECT_ID` (that variable is reserved for the
  emulator path) — a stray/leftover env var can never silently redirect
  this at the wrong real project. Passing `--allow-real-firebase` while
  `FIREBASE_AUTH_EMULATOR_HOST` is also set is refused outright (the
  Admin SDK would route through the emulator anyway, making the
  combination meaningless and confusing).
- **No shared/logged password.** `DevPassword123!` (the emulator-only
  constant) is never used here. New real accounts are created with **no
  password at all**; the script generates a one-time Firebase
  password-reset link (`generate_password_reset_link`) and prints it
  **once**. Copy it immediately and send it to the actual account owner
  over a secure channel — do not redirect this command's output to a file
  or paste it into a ticket/chat log, and do not run it inside something
  that persists terminal scrollback you don't control. A generated
  one-off password was considered and rejected: a reset link never exists
  anywhere as a working credential this script (or its output) holds, and
  it puts the actual staff member in control of setting their own
  password rather than the operator running the seed command knowing it.
- **Idempotent by verification, not by overwrite.** Re-running is safe:
  if a Firebase user already exists with the expected uid, the script
  checks its email matches and leaves it untouched (no churn, no new
  reset link) — it never overwrites a real account's password or email.
  If the uid is free but the email is already claimed by a *different*
  uid, that's treated as the dangerous case it is: the script refuses and
  explains, rather than either failing confusingly or (worse) silently
  proceeding in a way that could orphan or collide with an existing real
  account.
- **Production-project-name guard.** Analogous to the existing
  `DATABASE_URL`-looks-like-production guard: if
  `--real-firebase-project-id` contains `prod`, the script refuses unless
  `SEED_ALLOW_PROD_LOOKING_FIREBASE_PROJECT=1` is set. Same caveat as the
  database guard — a heuristic, not a substitute for pointing this at the
  project you actually mean to.

See `_seed_firebase_real_users` in `scripts/seed_dev.py` for the full
implementation and the reasoning behind each guardrail in its docstring.

### What is and isn't verified for this real-project path

**Verified** (this sandbox has no real GCP project or credentials, so this
is as far as it goes): the CLI-argument guardrails
(`_validate_firebase_mode_args`, `_guard_against_production_firebase_project`)
and the full `_seed_firebase_real_users` provisioning logic — uid lookup,
email-match verification on an existing uid, email-collision refusal on a
free uid claimed by a different account, no-password account creation,
reset-link generation, and a create-time race reported rather than
crashing — against a **mocked** `firebase_admin.auth` (no network, no real
project). See `tests/test_seed_dev.py`. The pre-existing emulator path
(`_seed_firebase_emulator_users`) was re-run end to end against a live
`firebase emulators:start --only auth` after this change, confirming it is
unaffected (see "Firebase Auth emulator" above).

**Not verified** (needs a real environment, and it would not be
appropriate to touch a real project from this sandbox): actually running
`--allow-real-firebase` against a live Firebase project — the real
`create_user()`/`get_user()`/`get_user_by_email()`/
`generate_password_reset_link()` calls, real Application Default
Credentials resolution from a downloaded service-account key, and an
end-to-end sign-in using the resulting reset link. Before relying on this
in your own project: run the command above once against a real (ideally
non-production) Firebase project, confirm the printed reset link works,
and confirm `GET /api/v1/me` succeeds with the resulting ID token — then
re-run the same command a second time and confirm it reports both accounts
as "already exists ... and matches" with no new reset link, and no
password/email change to the accounts.

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

Both verified in the sandbox (counts below are current as of the
real-Firebase-project provisioning work — `tests/test_seed_dev.py` added 15
tests; see "Verification performed when real-Firebase-project provisioning
was added" below):

```
$ pytest -q
........................................................................ [ 60%]
................................................                         [100%]
120 passed in 3.28s

$ DATABASE_URL=postgresql+asyncpg://ubk:ubk@localhost:5432/ultimate_bookkeeping_ci pytest -q
........................s............................................... [ 60%]
................................................                         [100%]
119 passed, 1 skipped in 11.94s
```

(The single skip is pre-existing and unrelated to anything in this change —
present before and after.)

Also verified the CI-equivalent Alembic round-trip check (fresh database,
`alembic upgrade head` then `alembic check`) reports no drift.

## Verification performed when Firebase Auth emulator support was added

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

## Verification performed when real-Firebase-project provisioning was added

Ran in this sandbox (same local Postgres 16 + `firebase emulators:start
--only auth` as above; still no real GCP project or credentials available
here — see the "not verified" list below):

1. `ruff check scripts/seed_dev.py tests/test_seed_dev.py` — clean.
2. New unit tests, `tests/test_seed_dev.py` (Admin SDK `auth.*` calls
   mocked, no network/real project) — 15 tests covering:
   `--allow-real-firebase`/`--real-firebase-project-id` opt-in validation
   (including the "stray `$FIREBASE_PROJECT_ID` env var is never
   consulted" case and the emulator-host mutual-exclusivity refusal), the
   production-looking-project-id guard (default refusal + explicit
   override), a fresh-uid creation (no `password=` kwarg ever passed,
   reset link printed, `DevPassword123!` never appears in real-path
   output), matching-uid idempotency (left untouched, no new reset link),
   mismatched-email-on-existing-uid refusal, email-claimed-by-a-different-
   uid refusal (the "dangerous case"), a racing `create_user()` reported
   rather than raised, and a multi-identity run where one bad identity
   doesn't block provisioning the other. All 15 passed:
   ```
   $ pytest -q tests/test_seed_dev.py
   ...............                                                          [100%]
   15 passed in 0.13s
   ```
3. Re-ran the *pre-existing* emulator path end to end against a live
   emulator, both before touching `scripts/seed_dev.py` (baseline) and
   after (regression check) — identical behavior both times:
   ```
   $ FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIREBASE_PROJECT_ID=ultimate-bookkeeping-dev \
       python -m scripts.seed_dev --admin-uid 11111111-1111-4111-8111-111111111111 \
       --manager-uid 22222222-2222-4222-8222-222222222222
   ...
     created emulator user admin@ultimatebookkeeping.dev (uid=11111111-1111-4111-8111-111111111111)
     created emulator user manager@ultimatebookkeeping.dev (uid=22222222-2222-4222-8222-222222222222)
     Emulator login password for both accounts: DevPassword123!
   ```
4. Manually exercised the new CLI guardrails end to end (real process,
   real argparse, no mocking) — each refused with exit code 1 and, for the
   first three, **no database write attempted** (confirmed no "database
   rows ready" line was printed before the refusal):
   - `--allow-real-firebase --real-firebase-project-id my-proj` with
     `FIREBASE_AUTH_EMULATOR_HOST` set → refused (mutual exclusivity).
   - `--allow-real-firebase` alone (no project id) → refused.
   - `--real-firebase-project-id foo` alone (no opt-in) → refused.
   - Neither flag set → ran normally, database rows written, and printed
     the (updated) manual-instructions message pointing at this new path.
5. Full `pytest` suite, both backends (output in "Running the tests"
   above): 120 passed (SQLite), 119 passed + 1 pre-existing skip
   (Postgres).

### What was **not** verified (needs a real environment)

- **Actually running `--allow-real-firebase` against a real Firebase
  project.** This sandbox has no GCP project and no service-account
  credentials, and it would not be appropriate to reach out to the user's
  real infrastructure from here. Everything Firebase-specific above is
  either against the local emulator (unchanged code path, re-verified for
  regressions) or against a mocked `firebase_admin.auth` (the new
  provisioning logic's actual decision-making). The real
  `create_user()` / `get_user()` / `get_user_by_email()` /
  `generate_password_reset_link()` HTTP calls, real
  `credentials.ApplicationDefault()` resolution from a downloaded
  service-account key, and an actual end-to-end sign-in using the printed
  reset link are all unverified. See "What is and isn't verified for this
  real-project path" under "Real Firebase project" above for exactly what
  to check once you have a real project.
- Everything already listed as unverified in the section above this one
  (outlet app integration, Windows, production deploy configuration)
  remains unverified for the same reasons.

## What you still need to bring

- A real Firebase project (or continued use of the emulator) — this repo
  contains no Firebase project of its own.
- If not using the emulator: a service-account key
  (`GOOGLE_APPLICATION_CREDENTIALS`) for that project, and real Firebase
  users provisioned with `uid=` explicitly set to match the `users.id`
  UUIDs you seed (see the PROVISIONING INVARIANT note in `app/auth.py`).
  `scripts/seed_dev.py --allow-real-firebase` (see "Real Firebase project"
  above) can now do this for the one coherent admin/outlet_manager demo
  tenant it seeds; it is still a dev/bootstrap tool, not general staff
  provisioning — ongoing, arbitrary-cardinality account provisioning for
  real outlet staff belongs in `/apps/admin` per `/CLAUDE.md`.
- A Postgres instance for anything beyond quick local exploration on
  SQLite (the app never runs on SQLite outside the test suite).
