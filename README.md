# Ultimate Bookkeeping v2

Rebuild of Ultimate Bookkeeping as two purpose-built apps sharing one backend.
This repo currently contains the **Outlet app** (POS, stock, expenses for a
single outlet manager) and the API it talks to. The admin console
(liabilities, settlements, cross-outlet reports) lives separately in
`/apps/admin` and is not built yet.

| Path | What it is |
|---|---|
| `apps/api` | FastAPI + SQLAlchemy (async) + Postgres. [Its own README](apps/api/README.md) has the detail. |
| `apps/outlet` | React + Vite PWA, offline-first. [Its own README](apps/outlet/README.md) has the detail. |
| `packages/offline-queue` | IndexedDB write queue — the offline-write contract |
| `packages/api-client` | Thin fetch wrappers over `/api/v1/*` |
| `packages/shared-types` | Wire shapes mirroring the API contract |
| `packages/shared-ui` | Button/Input/Modal primitives |

Design docs: [`ultimate-bookkeeping-v2-design.md`](ultimate-bookkeeping-v2-design.md)
(data model + offline-write contract),
[`ultimate-bookkeeping-v2-api-contracts.md`](ultimate-bookkeeping-v2-api-contracts.md)
(endpoint specs), and [`CLAUDE.md`](CLAUDE.md) (non-negotiable constraints).

---

## Running it locally

Two processes: the API on **:8000** and the Vite dev server on **:5173**,
which proxies `/api` to the API. You also need Postgres, and something to
authenticate against — the **Firebase Auth emulator** is the easy path and
needs no GCP project.

### Prerequisites

- Python 3.11+, Node 22+
- Postgres 16 you can create a database on
- `firebase-tools` (`npm i -g firebase-tools`) if using the Auth emulator

### 1. Backend

```bash
cd apps/api
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

createdb ultimate_bookkeeping_dev        # or your preferred method
export DATABASE_URL="postgresql+asyncpg://USER:PASS@localhost:5432/ultimate_bookkeeping_dev"
alembic upgrade head
```

Schema comes **only** from Alembic — nothing calls `create_all` against a
real database.

### 2. Auth emulator (recommended for local dev)

In its own terminal, from `apps/api`:

```bash
firebase emulators:start --only auth     # uses the committed firebase.json
```

Then seed, with the emulator variable set so the database rows and the
Firebase users are created with matching uids:

```bash
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
export FIREBASE_PROJECT_ID=ultimate-bookkeeping-dev
python -m scripts.seed_dev \
  --admin-uid 11111111-1111-4111-8111-111111111111 \
  --manager-uid 22222222-2222-4222-8222-222222222222
```

This creates two users, an outlet, and eight products with stock levels.
It is idempotent, and refuses to run against a database whose name contains
`prod` or a non-loopback host.

> **The one thing that will silently break you:** `users.id` must equal the
> Firebase uid. `users.id` is a UUID column, but Firebase's *default*
> auto-generated uids are 28-character non-UUID strings — so an account
> created through the Firebase Console, or via `create_user()` without an
> explicit `uid=`, can never authenticate. It surfaces as a permanent "ask
> your admin" screen even after the database row exists. The seed script
> handles this for you; if you provision by hand, pass `uid=` explicitly.
> See the provisioning invariant in `apps/api/app/auth.py`.

### 3. Run the API

```bash
cd apps/api && make run          # or: uvicorn app.main:app --reload --port 8000
```

With `FIREBASE_AUTH_EMULATOR_HOST` set, startup logs a loud warning that the
process accepts emulator tokens. That variable must never be set in a
deployed environment.

### 4. Frontend

```bash
npm install                      # from the repo root — npm workspaces
cp apps/outlet/.env.example apps/outlet/.env.local
# set VITE_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 for emulator mode
npm run dev:outlet
```

Open http://localhost:5173 and sign in with the seeded manager account
(`manager@ultimatebookkeeping.dev` / `DevPassword123!` when seeded against
the emulator).

`API_BASE` is deliberately the relative `/api/v1` so a bearer token can
never be sent to a third-party origin. The dev server proxies `/api` to
`http://localhost:8000`; override with `DEV_API_PROXY_TARGET` if your API
runs elsewhere. Don't "fix" this by making `API_BASE` absolute.

---

## Tests

```bash
cd apps/api && pytest                       # 197 + 3 skipped, SQLite, no setup needed
DATABASE_URL=postgresql+asyncpg://... pytest  # same suite against Postgres: 199 + 1 skipped

npm run test:outlet          # 192
npm run test:offline-queue   # 46
npm run test:api-client      # 10
npm run build:outlet
```

CI runs all of these on every PR, including the Postgres job — SQLite does
not enforce `NUMERIC(12,2)` precision or foreign keys, so the Postgres run
is what actually protects the money paths.

That same FK enforcement is why the Postgres run reports one skip:
`test_outlet_manager_with_dangling_outlet_id_gets_outlet_not_found` models a
`users.outlet_id` pointing at a deleted outlet, which SQLite stores happily
and Postgres physically refuses. The skip is deliberate and explained at the
`skipif` in `tests/test_authz.py` — a Postgres run of 127 passed / 1 skipped
is the expected green result, not a masked failure.

The skips run the other way too: `tests/test_stock_concurrency.py` (3 tests)
is Postgres-only. SQLite's shared in-memory connection serializes concurrent
requests at the driver, so the lost-update race those tests cover cannot
occur there and a pass would prove nothing.

The JS suites are hermetic with respect to `.env.local`: `vitest.config.js`
forces `VITE_FIREBASE_*` blank, so `npm run test:outlet` gives the same 192
whether or not you followed the `cp .env.example .env.local` step above.
Don't remove that override — without it, the tests asserting the Firebase
SDK is never loaded when unconfigured will instead initialize it for real.

---

## Notes and known gaps

- **No service worker in `npm run dev`.** Offline behaviour and caching only
  exist in a production build (`npm run build:outlet` + `vite preview`).
- **PWA icons are placeholders** pending real brand assets.
- **A real Firebase project** (service-account key, `GOOGLE_APPLICATION_CREDENTIALS`)
  is untested — only the emulator path and the credential-less fail-closed
  path have been verified.
- **Windows** is unverified; everything above was run on Linux.
- **`client_id` is not validated as a UUID.** The schema accepts any
  non-empty string (`client_id: str = Field(min_length=1)`), while
  uniqueness is enforced GLOBALLY — one namespace shared by every tenant.
  `app/authz.py`'s `assert_client_id_not_another_tenants` makes a collision
  safe (409 rather than leaking or discarding a write), but a modified
  client can still squat a short id so another tenant's write is refused.
  Validating it as a UUID closes that; it costs updating ~60 readable test
  fixtures (`"adj-1"`, `"client-half-up-boundary"`), which is why it was
  costed separately rather than bundled in.
- **The deploy pipeline is still being shaken out.** The image builds and
  pushes, and the migration job runs, but no end-to-end deploy has yet
  succeeded. Treat a deploy as an experiment, not a routine, until one has.

---

## Deployment

Firebase Hosting serves the outlet PWA and rewrites `/api/**` to the API on
Cloud Run, with Postgres on Cloud SQL. The rewrite is what keeps the app and
the API **same-origin**, which the relative `API_BASE` depends on — see the
note in `firebase.json`. Don't split them across origins.

One-time setup (idempotent, safe to re-run):

```bash
./infra/bootstrap-gcp.sh --dry-run    # inspect first
./infra/bootstrap-gcp.sh
```

That creates the Artifact Registry repo, two least-privilege service
accounts, a Workload Identity pool/provider bound to this repo, and an empty
`database-url` secret — then prints the GitHub secrets and variables to set
and the remaining manual steps.

It deliberately does **not** create the Cloud SQL instance: that is the only
resource that bills continuously from the moment it exists (~$10–25/month on
`db-f1-micro`, no scale-to-zero), so it stays an explicit command you run
yourself. The script prints it.

Deploys are **manual** (Actions → Deploy → type `deploy`). Automatic
deploy-on-merge is deliberately not enabled until the pipeline has been
watched to succeed a few times.

Two properties worth preserving if you change any of this:

- **`alembic upgrade head` runs as a Cloud Run Job, from the image just
  built, and must succeed before the service deploys.** A migration failure
  leaves the previous revision serving against the previous schema. Running
  migrations from the container entrypoint instead would race every instance
  Cloud Run starts against every other one.
- **The Cloud Run service must be `--allow-unauthenticated`.** That is a
  platform-level IAM setting, not an application one. Firebase Hosting does
  not attach an identity token when it rewrites to Cloud Run, so a private
  service answers Hosting with Google's own HTML 403 and the request never
  reaches the app — the site loads, every `/api/**` call 403s, and nothing
  appears in the application logs because nothing arrived. What guards the
  API is Firebase ID-token verification on every route plus rate limiting;
  platform IAM was never doing that work. The `*.run.app` URL being
  reachable is not a cross-origin token risk either: `API_BASE` is relative,
  so the browser only ever sends tokens to the Hosting origin.

No service-account key exists anywhere in this pipeline: GitHub authenticates
via Workload Identity Federation, and the deployed API verifies Firebase ID
tokens using its runtime service account's `roles/firebaseauth.admin`. If you
find yourself adding a JSON key to make something work, that is the signal to
stop and fix the identity instead.
