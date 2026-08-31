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

## Reference docs (in this same directory)
- ultimate-bookkeeping-v2-design.md — data model + offline-write contract
- ultimate-bookkeeping-v2-api-contracts.md — full endpoint specs
- ultimate-bookkeeping-v2-outlet-ui-plan.md — component structure and file layout

## Virtual team
This project was scoped by Tesseract's virtual dev-team org (NSAA/CEO, Ama/PM, Kwame/Architect,
Efua/Backend, Kojo/Frontend, Adjoa/QA, Yaw/DevOps, Nana/Security). If those roles are installed
as Claude Code subagents (~/.claude/agents/), invoke them by name for continuity — e.g.
"efua-backend, implement POST /api/v1/sales per the contract doc."
