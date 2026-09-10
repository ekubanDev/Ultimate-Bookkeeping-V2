# Ultimate Bookkeeping — Outlet app

POS, stock, and expenses for one outlet manager. See the repo root
`CLAUDE.md` for the scope boundary between this app and the admin console
(`/apps/admin`, not in this repo yet), and the reference docs there
(`ultimate-bookkeeping-v2-design.md`, `-api-contracts.md`,
`-outlet-ui-plan.md`) for the data model and offline-write contract this
app implements against.

This app never talks to Postgres/Firestore directly — every mutation is a
POST to the FastAPI backend in `apps/api`. **You need that backend running
(or its Auth-emulator equivalent) for anything beyond the bare login/loading
screen to work.**

## Prerequisites

- **Node.js 22** and npm 10+ (matches `.github/workflows/ci.yml`'s
  `actions/setup-node` version — use the same major version locally to
  avoid "works in CI, not for me" surprises).
- The backend, `apps/api` — see that directory / Efua's docs for how to run
  it. This app's dev proxy (below) expects it on `http://localhost:8000` by
  default.
- Optional: the [Firebase CLI](https://firebase.google.com/docs/cli) (`npm
  install -g firebase-tools` or `npx firebase-tools`) if you want to run the
  **Auth emulator** instead of a real Firebase project — see "Firebase
  auth" below. Not required if you have a real Firebase project to point
  at instead.

## Installing

This app is one workspace in an npm-workspaces monorepo — install from the
**repo root**, not from `apps/outlet`:

```sh
cd /path/to/Ultimate-Bookkeeping-V2
npm ci
```

This installs `apps/outlet` and every `packages/*` workspace (including
`@ub/offline-queue` and `@ub/api-client`, which `apps/outlet` depends on via
the `workspace:*`-style `"*"` version in its `package.json`) in one pass,
with npm symlinking the local packages instead of fetching them from a
registry.

## Environment variables

```sh
cp apps/outlet/.env.example apps/outlet/.env.local
```

`.env.local` takes precedence over `.env` in Vite and is gitignored (as is
every `.env*` file except the checked-in `.env.example` — see the repo's
`.gitignore`), so this is the file to actually edit.

Two supported local combinations — **pick one** (full reasoning and exact
values are in the comments in `.env.example` itself; this is the summary):

| Var | Real Firebase project | Auth emulator |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | real value from Firebase console | any non-blank dummy, e.g. `demo-api-key` |
| `VITE_FIREBASE_AUTH_DOMAIN` | real value from Firebase console | any non-blank dummy, e.g. `localhost` |
| `VITE_FIREBASE_PROJECT_ID` | real value from Firebase console | any non-blank dummy, e.g. `demo-ultimate-bookkeeping` |
| `VITE_FIREBASE_AUTH_EMULATOR_HOST` | unset | `127.0.0.1:9099` (bare `host:port`, no `http://`) |
| `DEV_API_PROXY_TARGET` | usually unset (defaults to `http://localhost:8000`) | same |

If the three `VITE_FIREBASE_*` vars are all unset/blank, the app boots into
a clearly-labeled "auth not configured" screen instead of crashing or
faking a signed-in state — see `isFirebaseConfigured` in
`src/auth/firebase.js`. This is a deliberate fail-loud choice, not a bug.

For the emulator path, start it separately (in another terminal) before
`npm run dev`:

```sh
firebase emulators:start --only auth
```

By default that serves the emulator on `127.0.0.1:9099` (matching the
`.env.example` default) with an Emulator UI at `http://localhost:4000`
where you can create a test user. Efua is wiring up the matching backend
side via the `FIREBASE_AUTH_EMULATOR_HOST` env var on `apps/api` — set it
to the **same** `host:port` value there so both sides verify tokens against
the same emulator instance instead of one hitting a real GCP project. Note
that signing in against the emulator only gets you as far as a valid
Firebase session — the backend also needs a corresponding `users` row for
that Firebase uid, or `/me` returns `USER_NOT_PROVISIONED` and this app
shows its `unprovisioned` state (see `src/auth/AuthContext.jsx`); that
provisioning step is on the backend/DB side, outside this app.

## Running the dev server

```sh
npm run dev --workspace=apps/outlet
# or, from the repo root:
npm run dev:outlet
```

Serves on `http://localhost:5173`. Every `/api/...` request from the app
(all of it goes through `@ub/api-client`, `API_BASE = "/api/v1"`) is
proxied by the Vite dev server to `DEV_API_PROXY_TARGET`
(`http://localhost:8000` by default) — see the large comment on the
`server.proxy` block in `vite.config.js` for exactly why this exists and
why `API_BASE` itself stays a relative, same-origin path rather than an
absolute URL (short version: so a bearer token can structurally never be
sent to the wrong origin, in dev or prod). If the backend isn't running,
API calls will fail with a connection error surfaced through the normal
app UI (e.g. the login screen's error state, or `SyncBanner` for
offline-queued writes) — that's expected, not a proxy misconfiguration.

## Service worker behaviour in dev (read this before filing a "caching is
broken" bug)

This app registers a Workbox-generated service worker
(`vite-plugin-pwa`, see `vite.config.js`) for offline app-shell support and
the GET `/api/v1/products` runtime cache. **In `npm run dev`, no service
worker is actually registered at all** — `vite-plugin-pwa`'s dev-mode
support (`devOptions.enabled`) defaults to `false` and this repo doesn't
override it, so `virtual:pwa-register/react` (used by
`src/pwa/UpdatePrompt.jsx`) is a no-op in dev. Concretely:

- No offline app-shell caching in dev — reloading while your dev-server tab
  is offline will not work the way it does in a built/deployed app.
- No `StaleWhileRevalidate` caching of the products catalog in dev — every
  GET goes straight to the network (proxied per above) every time.
- No update-prompt banner in dev — there's nothing to update; you're always
  running the latest source directly.

None of this indicates a bug in `src/pwa/*` — it's the intended tradeoff
(instant HMR during development vs. exercising the real SW lifecycle). To
actually see SW/offline behaviour, use the production build:

```sh
npm run build --workspace=apps/outlet
npm run preview --workspace=apps/outlet
```

`vite preview` serves the real `dist/` output, including the generated
`sw.js`, so this is the only local way to exercise precaching, the
products runtime cache, and the update-prompt lifecycle described in
`src/pwa/UpdatePrompt.jsx`. Vite's `preview.proxy` config defaults to
`server.proxy` (Vite's own documented behaviour), so `/api/...` still
proxies to `DEV_API_PROXY_TARGET` here too — confirmed by running it:
`curl http://localhost:5173/api/v1/me` under `vite preview` produced the
same `ECONNREFUSED 127.0.0.1:8000` proxy error as under `vite dev` with no
backend running, not a 404. Don't assume otherwise; this is genuinely a
dev-tooling convenience, not something real (deployed) infra gives you for
free — a real deployment still needs its own same-origin routing between
the built static assets and the API.

## Running the tests

```sh
npm run test --workspace=apps/outlet
# or, from the repo root:
npm run test:outlet
```

Runs the full Vitest suite (jsdom environment — see `vitest.config.js`).
`@ub/offline-queue` is mocked in these component tests rather than
exercised for real (no IndexedDB polyfill is configured here); its own
suite lives in `packages/offline-queue` and runs separately:

```sh
npm run test:offline-queue   # packages/offline-queue
npm run test:api-client      # packages/api-client
```

None of these suites need the backend running or a real/emulated Firebase
project — Firebase and `@ub/api-client`'s `fetch` are mocked at the
module/network boundary in the relevant test files (e.g.
`src/auth/firebase.emulator.test.js` mocks `firebase/app` /
`firebase/auth` directly rather than hitting a real SDK or emulator).

## Building

```sh
npm run build --workspace=apps/outlet
# or, from the repo root:
npm run build:outlet
```

Outputs to `apps/outlet/dist/` (sourcemaps on — see `vite.config.js`'s
`build` block). This is also what CI runs (`.github/workflows/ci.yml`'s
`js-tests` job) after the three test suites above, so a green `npm run
build:outlet` locally is a reasonable proxy for "CI's build step will
pass" too.

## What running this locally does NOT verify

Getting the dev server itself booted and serving only proves the frontend
half of the round trip. Whether a signed-in cashier can actually complete
a sale/adjustment/expense end-to-end additionally requires:

- `apps/api` running and reachable at whatever `DEV_API_PROXY_TARGET`
  points to, with its own DB/migrations set up (see that app's own
  docs/Efua).
- Either a real Firebase project matching your `VITE_FIREBASE_*` values, or
  the Auth emulator running on the host:port in
  `VITE_FIREBASE_AUTH_EMULATOR_HOST`, matched by `FIREBASE_AUTH_EMULATOR_HOST`
  on the backend.
- A `users` row provisioned on the backend for whatever Firebase account
  you sign in with (see "Environment variables" above).
