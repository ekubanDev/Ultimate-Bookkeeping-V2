# Functional Programming Guide — Tesseract Dev Team
**Drafted by:** Kwame (Architect), with input from Efua (Backend) and Kojo (Frontend)
**Purpose:** Equip the roster with shared FP vocabulary and patterns, translated into the team's actual stack (JS/TS + Python), and applied directly to the Ultimate Bookkeeping v2 rebuild so this is a working reference, not shelf theory.

---

## 1. Why this matters for THIS project specifically

The v2 design leans on a few things that FP principles protect directly:

- **Ledger-style tables (append-only, never mutate history)** — this is functional thinking already, just at the database layer. The application code that writes to `sales`, `stock_movements`, `expenses` should mirror that: build new records, don't mutate existing state in place.
- **The offline-queue package** — intents are immutable once created (`client_id` never regenerates), and syncing is essentially "replay a list of pure operations against the server." This is a natural fit for FP patterns and will fall apart if it's built with mutable, stateful logic instead.
- **Idempotency** — a core FP property (pure functions given the same input always produce the same output) maps directly onto the idempotent-replay requirement Efua specified. Thinking in these terms while implementing will prevent bugs, not just describe them after the fact.

---

## 2. Core FP concepts (language-agnostic)

**Pure functions** — same input, same output, no side effects (no network calls, no mutating external state, no `Date.now()` inside the function). Side effects get pushed to the edges of the system, not buried in business logic.

**Immutability** — data isn't changed in place; a new value is produced instead. Prevents an entire class of bugs where one part of the code changes something another part didn't expect.

**Composition** — build complex behavior by chaining small, single-purpose functions rather than writing one large function that does everything. Directly counters the monolith-file problem the old codebase had.

**First-class functions** — functions can be passed as arguments, returned from other functions, stored in variables. Enables composition and things like middleware, validators, and reducers.

**Referential transparency** — a function call can be replaced with its return value without changing program behavior. If this doesn't hold, the function has a hidden side effect worth finding.

**Avoiding shared mutable state** — especially critical in async/concurrent code (FastAPI request handlers, React state updates) where two things touching the same mutable object at the same time is a classic bug source.

---

## 3. Applied to Python / FastAPI (Efua's domain)

```python
# NOT this — mutates a shared dict, side effect buried in business logic
def process_sale(sale_data, inventory_cache):
    inventory_cache[sale_data["product_id"]] -= sale_data["quantity"]  # mutation!
    return {"status": "ok"}

# THIS — pure function, returns new state instead of mutating
def compute_stock_delta(product_id: str, quantity: int) -> StockMovement:
    return StockMovement(
        product_id=product_id,
        delta=-quantity,
        reason="sale",
    )
    # caller is responsible for persisting — this function only computes
```

- **Use `functools.reduce` / generator expressions** for aggregations (e.g. computing a sale's `total_amount` from line items) instead of loops that accumulate into a mutable variable — same result, no accidental state leakage.
- **Dataclasses / Pydantic models as immutable value objects** — construct new instances rather than mutating fields on an existing one (`sale.copy(update={...})` rather than `sale.status = "voided"`).
- **Keep the Postgres transaction boundary (§3.4 of the design doc) as the one place side effects happen** — everything that computes what should be written stays pure; only the actual `INSERT`/`UPDATE` inside the transaction touches the database. This makes the sale-processing logic trivially testable without spinning up Postgres.
- **Idempotency check as a pure predicate** — `is_duplicate(client_id, existing_ids) -> bool` — testable without any I/O.

---

## 4. Applied to React / TypeScript (Kojo's domain)

```typescript
// NOT this — mutates cart state directly
function addToCart(cart, item) {
  cart.items.push(item);  // mutation!
  return cart;
}

// THIS — pure function, returns new state
function addToCart(cart: Cart, item: LineItem): Cart {
  return { ...cart, items: [...cart.items, item] };
}
```

- **`useCart` should be a reducer, not scattered `useState` mutations** — `useReducer(cartReducer, initialCart)` where `cartReducer` is a pure function `(state, action) => newState`. This maps directly onto the `useCart` hook specified in the Outlet UI plan.
- **Derived values are computed, not stored** — cart total should be a pure function of `cart.items`, not a separate piece of state that can drift out of sync (this is the same "don't let two things disagree" principle behind Ama's data-trust-parity KPI, just at the component level).
- **The offline-queue package should expose pure functions for building intents** — `buildSaleIntent(cart, outletId) -> Intent` — separate from the actual side-effecting `enqueue()` call. Makes intent construction testable without touching IndexedDB at all.
- **Avoid side effects in render** — API calls and queue writes belong in event handlers or `useEffect`, never in the body of a component function.

---

## 5. Where FP purity should yield to pragmatism

Not a dogma — a few places where forcing pure FP would fight the tools rather than help:

- **React's rendering model already requires some local mutable state (`useState`)** — that's fine; the discipline is about *not smuggling extra mutation in* around it, not eliminating `useState` itself.
- **Database transactions are inherently effectful** — no amount of FP purity removes that; the goal is *containing* the effect to one clearly-bounded place (the transaction block), not pretending it doesn't exist.
- **Performance-critical loops in Python** — a `for` loop mutating a local accumulator is sometimes clearer and faster than a chain of `map`/`filter`/`reduce`. Use judgment; the point of FP here is correctness and testability for financial logic, not stylistic purity everywhere.

---

## 6. Quick reference — where this shows up in the v2 build

| Area | FP principle applied |
|---|---|
| `useCart` / `useSubmitSale` (Kojo) | Reducer pattern, pure derived totals |
| `offline-queue` package | Pure intent-building, effects isolated to `enqueue()`/sync |
| Sale-processing logic (Efua) | Pure computation functions, side effects contained to the transaction block |
| Idempotency checks | Pure predicate functions, easily unit-testable |
| Stock/expense ledger writes | Append-only, immutable-history pattern (mirrors FP immutability at the DB layer) |
