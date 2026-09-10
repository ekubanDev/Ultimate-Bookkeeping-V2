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
cd apps/api && pytest                       # 105, SQLite, no setup needed
DATABASE_URL=postgresql+asyncpg://... pytest  # same suite against Postgres

npm run test:outlet          # 176
npm run test:offline-queue   # 46
npm run test:api-client      # 10
npm run build:outlet
```

CI runs all of these on every PR, including the Postgres job — SQLite does
not enforce `NUMERIC(12,2)` precision or foreign keys, so the Postgres run
is what actually protects the money paths.

---

## Notes and known gaps

- **No service worker in `npm run dev`.** Offline behaviour and caching only
  exist in a production build (`npm run build:outlet` + `vite preview`).
- **PWA icons are placeholders** pending real brand assets.
- **A real Firebase project** (service-account key, `GOOGLE_APPLICATION_CREDENTIALS`)
  is untested — only the emulator path and the credential-less fail-closed
  path have been verified.
- **Windows** is unverified; everything above was run on Linux.
- **Deployment** must run `alembic upgrade head` before serving traffic. The
  managed-Postgres provider decision is still open — see the analysis in the
  PR discussion.
