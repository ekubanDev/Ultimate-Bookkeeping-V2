# Ultimate Bookkeeping v2 — Outlet App UI/Component Structure
**Drafted by:** Kojo (Frontend) — Tesseract Holdings virtual dev-team org
**Builds on:** `ultimate-bookkeeping-v2-design.md`, `ultimate-bookkeeping-v2-api-contracts.md`
**Handoff note:** This plan is written for direct implementation in Claude Code — file paths are literal, not illustrative. Section 5 is a seed `CLAUDE.md` so a fresh Claude Code session in this repo has the context without needing this whole conversation re-explained.

---

## 1. Design intent

The Outlet app is one thing: **fast POS + daily ops for one outlet manager, on a cheap Android device, on a bad connection.** Every structural decision below optimizes for that — small bundle, no admin-only code loaded, no screen an outlet manager doesn't need.

Explicitly NOT building here: anything from the Admin console (liabilities, settlements, cross-outlet reports). That's a separate app under `/apps/admin`, built later, sharing `/packages` but not this app's routes or bundle.

---

## 2. File structure

```
/apps/outlet
  /src
    /features
      /pos
        PosScreen.jsx
        Cart.jsx
        ProductGrid.jsx
        CheckoutModal.jsx
        useCart.js              # cart state, local only until checkout
        useSubmitSale.js        # calls shared offline-queue package
      /stock
        StockScreen.jsx
        StockLevelList.jsx
        AdjustmentModal.jsx
        useSubmitAdjustment.js
      /expenses
        ExpensesScreen.jsx
        ExpenseForm.jsx
        useSubmitExpense.js
      /sync-status
        SyncBanner.jsx           # "3 items syncing" / "sync failed, resolve" UI
        useSyncStatus.js
    /navigation
      OutletNav.jsx              # bottom nav: POS / Stock / Expenses / Sync
    /App.jsx
    /main.jsx
  package.json
  vite.config.js                 # or CRA equivalent — Kwame/Efua to confirm build tool

/packages
  /offline-queue                 # shared, NOT outlet-app-specific — built once, used correctly
    index.js                     # enqueue(intent), onReconnect(), retry logic
    idempotency.js                # client_id generation
    types.ts
  /shared-ui
    Button.jsx, Input.jsx, Modal.jsx, ...   # design system, shared with /apps/admin later
  /shared-types
    sale.ts, stockAdjustment.ts, expense.ts  # mirrors the API contract shapes exactly
  /api-client
    salesApi.js, stockApi.js, expensesApi.js  # thin wrappers over POST /api/v1/*
```

**Why `/packages/offline-queue` is separate from `/features/pos`:** the same queue mechanics apply to stock adjustments and expenses, not just sales (per the design doc's offline scope). Building it once as a shared package — rather than three copies of "IndexedDB queue logic" — is the direct fix for the sprawl that caused `offline-sync.js` to end up buried and undocumented in the old codebase.

---

## 3. Component responsibility boundaries

| Component | Owns | Does NOT own |
|---|---|---|
| `PosScreen` | Layout, screen-level state | Cart math (delegates to `useCart`), API calls (delegates to `useSubmitSale`) |
| `useCart` | Line items, quantities, running total — pure client state | Submitting anything |
| `useSubmitSale` | Builds the `intent` object, calls `offline-queue.enqueue()`, exposes `status: 'idle'\|'queued'\|'synced'\|'failed'` | Cart state, UI rendering |
| `SyncBanner` | Reads global queue status via `useSyncStatus`, renders the "syncing / resolve" states from §3.4 of the design doc | Retrying or resolving — that's a user action routed back through `offline-queue` |

This mirrors the API contract directly: every `useSubmit*` hook maps 1:1 to one endpoint in `ultimate-bookkeeping-v2-api-contracts.md`, and every hook's `status` values map to the `idempotent_replay`/`retryable` fields Efua defined. Nothing here should require inventing new state shapes once implementation starts.

---

## 4. What's deliberately deferred

- Styling system specifics (Tailwind config, design tokens) — small decision, not architecturally load-bearing, can be settled at implementation time.
- i18n (English/Twi/French) — old app had this; worth carrying forward, but it's additive to this structure, not something that changes it. Flagging so it isn't forgotten, not solving it now.
- PWA/Capacitor mobile wrapper config — same as above, bolts on once the app itself exists.

---

## 5. Seed `CLAUDE.md` for the Outlet app repo

This is what should live at the repo root (or `/apps/outlet/CLAUDE.md`) so a fresh Claude Code session has working context immediately:

```markdown
# Ultimate Bookkeeping v2 — Outlet App

Rebuild of Ultimate Bookkeeping, redesigned as two purpose-built apps sharing one backend.
This repo/directory is the OUTLET app only — POS, stock, expenses for one outlet manager.
Admin console (liabilities, settlements, cross-outlet reports) lives separately in /apps/admin — do not add admin features here.

## Non-negotiable constraints
- Offline-first applies ONLY to: sales, stock adjustments, expenses. Nothing else queues offline.
- The app NEVER writes to Postgres or Firestore directly. Every mutation is a POST to the
  FastAPI backend, described in ultimate-bookkeeping-v2-api-contracts.md.
- Every offline-eligible write requires a client-generated `client_id` (UUID, generated once
  at intent creation, never regenerated on retry) — this is the idempotency key. See
  ultimate-bookkeeping-v2-design.md §3 for the full contract.
- Money values are strings representing NUMERIC(12,2) over the wire. Never use floats for money.
- created_at is always server-assigned. device_recorded_at is audit-only, never used for ordering.

## Structure
See /apps/outlet/src/features/* — one folder per feature (pos, stock, expenses, sync-status).
Shared offline-queue logic lives in /packages/offline-queue — use it, don't reimplement per feature.

## Reference docs
- ultimate-bookkeeping-v2-design.md — data model + offline-write contract
- ultimate-bookkeeping-v2-api-contracts.md — full endpoint specs
```

---

## 6. Open items before implementation starts

- [ ] Confirm build tool (Vite vs. CRA/craco carryover from old repo) — Kwame
- [ ] Confirm shared-ui package covers enough primitives to avoid Kojo hand-rolling basics — Kojo, at implementation start
- [ ] Placement decision: monorepo tool (plain npm workspaces vs. Turborepo) — Yaw, since it affects CI/build setup
