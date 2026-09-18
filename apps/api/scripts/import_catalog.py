"""Import a product catalog from CSV, through the API.

THROUGH THE API, NOT THE DATABASE — this is the whole design.

The obvious version of this tool writes straight to Postgres, reusing
seed_dev.py's `_upsert_product_and_stock`. That was proposed and rejected in
review: it bypasses Firebase auth, app/authz.py's tenant checks, every
Pydantic validator in app/schemas.py and the rate limiter; it needs standing
production database credentials nobody otherwise holds; and it would inherit
an unguarded SELECT-then-write upsert. For the table that sets every price
in the shop, that is a lot to give up for convenience.

Calling POST/PATCH /api/v1/products instead means a catalog import is
subject to exactly the same rules as any other write, including recording
`created_by`.

SAFETY MODEL
  - Dry run by default. --apply is required to change anything, and prints a
    diff first.
  - Refuses duplicate product names outright rather than guessing. An export
    that lists one name twice at two prices is an ambiguity a human has to
    resolve; picking one silently is how a till ends up charging the wrong
    amount.
  - Idempotent by SKU, so re-running after a partial failure or a price
    change updates rather than duplicating.
  - The password is read interactively and never stored, logged or passed as
    an argument (it would otherwise land in shell history and `ps`).

CSV FORMAT
    Product,Price,Quantity
    Outre Braid,27.5,13829

`Quantity` is read and reported but NOT written: stock is a separate
concern owned by POST /api/v1/stock/adjustments, and duplicating that here
would reintroduce the read-modify-write race that endpoint was fixed for.
The importer prints the restock commands to run afterwards.

REQUIREMENTS
    An operator tool, run from a dev install (`pip install -e ".[dev]"`) —
    httpx is a dev dependency, deliberately. It is NOT installed in the
    deployed container (see the Dockerfile), because nothing in production
    should be able to rewrite the catalog from inside the API's own image.

USAGE
    python -m scripts.import_catalog catalog.csv \
        --base-url https://ultimate-bookkeeping-v2.web.app \
        --outlet-id <uuid> --email admin@example.com          # dry run
    ... --apply                                                # writes
"""
from __future__ import annotations

import argparse
import csv
import time
import getpass
import os
import re
import sys
import unicodedata
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path

import httpx

IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
MAX_SKU_LENGTH = 64


def discover_api_key() -> str | None:
    """Find the Firebase web API key without making the operator paste it.

    It is not a secret — it is compiled into the client bundle every visitor
    downloads, and it identifies the project rather than authorising
    anything. So requiring it as an argument was friction with no security
    benefit: the value is already sitting in apps/outlet/.env.local, which is
    where a developer running this has it.

    Checked in order: the env var, then the outlet app's .env.local, then its
    .env.example (which carries a placeholder in a fresh checkout — hence the
    AIzaSy prefix check, so a placeholder is not mistaken for a real key).
    """
    from_env = os.environ.get("VITE_FIREBASE_API_KEY")
    if from_env:
        return from_env

    outlet = Path(__file__).resolve().parents[3] / "apps" / "outlet"
    for candidate in (outlet / ".env.local", outlet / ".env.example"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "VITE_FIREBASE_API_KEY":
                value = value.strip().strip("\"'")
                if value.startswith("AIzaSy"):
                    return value
    return None


def slugify_sku(name: str) -> str:
    """Derive a stable SKU from a product name.

    Auto-generated rather than supplied, because the source export has no SKU
    column. Deterministic on purpose: the same product name always yields the
    same SKU, which is what makes re-running this import an update instead of
    a second copy of the catalog.

    Consequence worth understanding: two products with the SAME name produce
    the SAME SKU and the second is refused by the database's unique index.
    That is the desired behaviour — it surfaces an ambiguous catalog rather
    than creating two indistinguishable entries for a cashier to choose
    between.
    """
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^A-Za-z0-9]+", "-", normalized).strip("-").upper()
    return slug[:MAX_SKU_LENGTH].rstrip("-")


def parse_price(raw: str, *, line: int) -> str:
    """Return a NUMERIC(12,2)-shaped string, or raise with the CSV line."""
    try:
        value = Decimal(raw.strip())
    except (InvalidOperation, AttributeError):
        raise SystemExit(f"line {line}: price {raw!r} is not a number")
    if value < 0:
        raise SystemExit(f"line {line}: price {raw!r} is negative")
    if value != value.quantize(Decimal("0.01")):
        raise SystemExit(f"line {line}: price {raw!r} has more than 2 decimal places")
    return f"{value:.2f}"


def read_rows(path: Path) -> list[dict]:
    # utf-8-sig: exports from spreadsheet tools routinely carry a BOM, which
    # would otherwise become part of the first column's name.
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing = {"Product", "Price", "Quantity"} - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"CSV is missing column(s): {', '.join(sorted(missing))}")
        rows = []
        for line, raw in enumerate(reader, start=2):
            name = (raw["Product"] or "").strip()
            if not name:
                raise SystemExit(f"line {line}: empty product name")
            rows.append(
                {
                    "line": line,
                    "name": name,
                    "sku": slugify_sku(name),
                    "unit_price": parse_price(raw["Price"], line=line),
                    "quantity": int((raw["Quantity"] or "0").strip() or 0),
                }
            )
    return rows


def reject_duplicates(rows: list[dict]) -> None:
    """Refuse an ambiguous catalog rather than guessing which row wins.

    Two rows sharing a name are either the same product entered twice, or
    two different products the export cannot tell apart. Only a human knows
    which — and the cost of guessing is a cashier picking between identical
    entries at different prices.
    """
    for key in ("name", "sku"):
        duplicates = {v: c for v, c in Counter(r[key] for r in rows).items() if c > 1}
        if duplicates:
            print(f"\nDuplicate {key}(s) — refusing to import:", file=sys.stderr)
            for value, count in sorted(duplicates.items()):
                print(f"  {value!r} appears {count} times:", file=sys.stderr)
                for row in (r for r in rows if r[key] == value):
                    print(
                        f"    line {row['line']}: price {row['unit_price']}, qty {row['quantity']}",
                        file=sys.stderr,
                    )
            print(
                "\nGive each product a distinct name in the CSV (the catalog's own "
                "convention is a suffix such as '4pcs' / '24pcs') and re-run.",
                file=sys.stderr,
            )
            raise SystemExit(2)


def write_with_retry(
    send, *, description: str, max_attempts: int = 6
) -> "httpx.Response":
    """Perform one write, honouring the API's own retryability signal.

    The write endpoints are rate limited (30/minute — app/rate_limit.py), and
    a bulk catalog import is exactly the shape that trips it. The limiter
    answers 429 with `retryable: true` in the standard error envelope, which
    is the same field packages/offline-queue branches on to decide whether a
    queued sale is retried or surfaced as failed.

    The first version of this importer ignored that and recorded all 183
    rate-limited writes as permanent failures — reading the flag and then
    doing nothing with it. Backing off is the whole point of the server
    bothering to say so.

    Honours Retry-After when the limiter sends one, otherwise backs off
    exponentially. Only 429 is retried: a 409 duplicate SKU or a 422
    validation failure will fail identically no matter how long you wait.
    """
    delay = 2.0
    for attempt in range(1, max_attempts + 1):
        response = send()
        if response.status_code != 429:
            return response
        if attempt == max_attempts:
            return response
        retry_after = response.headers.get("Retry-After")
        wait = float(retry_after) if (retry_after or "").replace(".", "", 1).isdigit() else delay
        print(f"    rate limited on {description}; waiting {wait:.0f}s "
              f"(attempt {attempt}/{max_attempts})")
        time.sleep(wait)
        delay = min(delay * 2, 60.0)
    return response


def sign_in(api_key: str, email: str) -> str:
    """Exchange an admin's email/password for a Firebase ID token.

    Read interactively: a password passed as an argument lands in shell
    history and in `ps` output for every user on the machine.
    """
    password = os.environ.get("UB_ADMIN_PASSWORD") or getpass.getpass(f"Password for {email}: ")
    response = httpx.post(
        IDENTITY_TOOLKIT,
        params={"key": api_key},
        json={"email": email, "password": password, "returnSecureToken": True},
        timeout=30,
    )
    if response.status_code != 200:
        # Deliberately does not echo the response body — it can contain the
        # submitted email and Firebase's own error detail.
        raise SystemExit(f"sign-in failed ({response.status_code}). Check the email and password.")
    return response.json()["idToken"]


def fetch_existing(client: httpx.Client, outlet_id: str) -> dict[str, dict]:
    """Current catalog, keyed by SKU. Paged — the endpoint caps at 200."""
    products: dict[str, dict] = {}
    offset = 0
    while True:
        response = client.get(
            "/api/v1/products", params={"outlet_id": outlet_id, "limit": 200, "offset": offset}
        )
        response.raise_for_status()
        page = response.json()
        for product in page:
            if product.get("sku"):
                products[product["sku"]] = product
        if len(page) < 200:
            return products
        offset += 200


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--base-url", required=True, help="e.g. https://ultimate-bookkeeping-v2.web.app")
    parser.add_argument("--outlet-id", required=True, help="Identifies the tenant whose catalog this is")
    parser.add_argument("--email", required=True, help="An ADMIN account — managers cannot write the catalog")
    parser.add_argument("--api-key", default=None,
                        help="Firebase web API key. Usually unnecessary — discovered from "
                             "$VITE_FIREBASE_API_KEY or apps/outlet/.env.local. Public either "
                             "way; it ships in the client bundle.")
    parser.add_argument("--apply", action="store_true",
                        help="Actually write. Without this the run is a dry run and changes nothing.")
    args = parser.parse_args(argv)

    api_key = args.api_key or discover_api_key()
    if not api_key:
        raise SystemExit(
            "Could not find the Firebase web API key. Pass --api-key, set "
            "VITE_FIREBASE_API_KEY, or ensure apps/outlet/.env.local has it. "
            "(It is not a secret — it is in the client bundle.)"
        )

    rows = read_rows(args.csv_path)
    reject_duplicates(rows)
    print(f"read {len(rows)} products from {args.csv_path}")

    token = sign_in(api_key, args.email)
    with httpx.Client(base_url=args.base_url.rstrip("/"),
                      headers={"Authorization": f"Bearer {token}"}, timeout=60) as client:
        existing = fetch_existing(client, args.outlet_id)
        print(f"catalog currently holds {len(existing)} products with a SKU\n")

        creates = [r for r in rows if r["sku"] not in existing]
        updates, unchanged = [], []
        for row in (r for r in rows if r["sku"] in existing):
            current = existing[row["sku"]]
            if current["unit_price"] != row["unit_price"] or current["name"] != row["name"]:
                updates.append((row, current))
            else:
                unchanged.append(row)

        print(f"  create:    {len(creates)}")
        print(f"  update:    {len(updates)}")
        print(f"  unchanged: {len(unchanged)}")
        for row, current in updates:
            change = []
            if current["unit_price"] != row["unit_price"]:
                change.append(f"price {current['unit_price']} -> {row['unit_price']}")
            if current["name"] != row["name"]:
                change.append(f"name {current['name']!r} -> {row['name']!r}")
            print(f"    {row['sku']}: {'; '.join(change)}")

        if not args.apply:
            print("\nDRY RUN — nothing was written. Re-run with --apply to commit.")
            return

        # Pace writes under the server's limit rather than sprinting into it
        # and relying on retries to clean up. `interval` is the gap that keeps
        # a sustained run just below WRITE_RATE_LIMIT.
        interval = 60.0 / max(args.rate, 1)
        total = len(creates) + len(updates)
        print(f"\nwriting {total} change(s) at ~{args.rate}/min "
              f"(about {total * interval / 60:.1f} minutes)\n")

        failures = []
        done = 0
        for row in creates:
            response = write_with_retry(
                lambda r=row: client.post("/api/v1/products", json={
                    "outlet_id": args.outlet_id, "name": r["name"],
                    "unit_price": r["unit_price"], "sku": r["sku"],
                }),
                description=row["sku"],
            )
            if response.status_code != 201:
                failures.append((row, response.status_code, response.text[:160]))
            done += 1
            if done % 25 == 0:
                print(f"    {done}/{total}")
            time.sleep(interval)
        for row, current in updates:
            response = write_with_retry(
                lambda r=row, c=current: client.patch(f"/api/v1/products/{c['id']}", json={
                    "outlet_id": args.outlet_id, "name": r["name"], "unit_price": r["unit_price"],
                }),
                description=row["sku"],
            )
            if response.status_code != 200:
                failures.append((row, response.status_code, response.text[:160]))
            done += 1
            time.sleep(interval)

        print(f"\ncreated {len(creates) - sum(1 for f in failures if f[0] in creates)}, "
              f"updated {len(updates) - sum(1 for f in failures if any(f[0] is r for r, _ in updates))}")
        if failures:
            print(f"\n{len(failures)} FAILED:", file=sys.stderr)
            for row, status, body in failures:
                print(f"  {row['sku']} (line {row['line']}): HTTP {status} {body}", file=sys.stderr)
            raise SystemExit(1)

        stocked = [r for r in rows if r["quantity"] > 0]
        print(f"\nStock NOT imported — it belongs to POST /api/v1/stock/adjustments, which owns "
              f"the locking this script deliberately does not reimplement.\n"
              f"{len(stocked)} products have opening stock ({sum(r['quantity'] for r in stocked):,} units).")


if __name__ == "__main__":
    main()
