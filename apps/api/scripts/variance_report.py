"""Daily price-variance review.

A pilot gate: someone looks at flagged sales every day for the first weeks,
because the price a device submits is the price charged (design.md §3.7) and
the only control is review after the fact.

WHAT A FLAG ACTUALLY MEANS HERE, which matters for reading this report.

The POS has no price field — prices are rendered, never typed (Cart.jsx,
ProductGrid.jsx), and useCart copies them from the catalog. So a cashier
cannot mistype a price. That leaves two causes:

  1. A STALE CATALOG. The service worker caches GET /products for up to 24
     hours (vite.config.js). Change a price and a till can keep selling at
     the old one until its cache revalidates. This is the common case, it is
     benign, and it resolves itself — but you want to know it happened,
     because those sales went through at the wrong margin.

  2. A MODIFIED CLIENT. Rare, deliberate, and the reason the flag exists at
     all. Distinguishable from (1) by the direction and size of the gap, and
     by whether a price change actually happened that day.

If a variance appears and you did NOT change that product's price recently,
(2) is the one to consider.

USAGE
    python -m scripts.variance_report --outlet-id <uuid> --email admin@...
    ... --days 7          # a week instead of yesterday+today
    ... --all             # every sale, not only flagged ones
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import httpx

from scripts.import_catalog import discover_api_key, sign_in


def money(value: str) -> Decimal:
    return Decimal(value)


def fetch_flagged(client: httpx.Client, outlet_id: str, since: datetime, flagged_only: bool) -> list[dict]:
    params = {
        "outlet_id": outlet_id,
        "from": since.isoformat(),
        "order": "desc",
        "limit": 200,
    }
    if flagged_only:
        params["price_variance_flagged"] = "true"
    response = client.get("/api/v1/sales", params=params)
    response.raise_for_status()
    return response.json()


def fetch_detail(client: httpx.Client, outlet_id: str, sale_id: str) -> dict:
    response = client.get(f"/api/v1/sales/{sale_id}", params={"outlet_id": outlet_id})
    response.raise_for_status()
    return response.json()


def describe_line(line: dict) -> str:
    """One line of a flagged sale, with the gap spelled out.

    Reports the DIFFERENCE explicitly rather than leaving two numbers for the
    reader to subtract: the whole failure mode of a review queue is that
    nobody reads it, and arithmetic in the reader's head is friction.
    """
    charged, catalog = money(line["unit_price"]), money(line["catalog_unit_price_at_sale"])
    gap = charged - catalog
    direction = "UNDER" if gap < 0 else "over"
    pct = (abs(gap) / catalog * 100) if catalog else Decimal(0)
    return (
        f"      {line['product_name'][:34]:<34} x{line['quantity']:<4} "
        f"charged {charged:>9} vs catalog {catalog:>9}  "
        f"{direction} by {abs(gap)} ({pct:.0f}%)"
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", default="https://ultimate-bookkeeping-v2.web.app")
    parser.add_argument("--outlet-id", required=True)
    parser.add_argument("--email", required=True, help="An account that can read this outlet's sales")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--days", type=int, default=1, help="How far back to look. Default 1.")
    parser.add_argument("--all", action="store_true",
                        help="Include unflagged sales too, for a full day's takings.")
    args = parser.parse_args(argv)

    api_key = args.api_key or discover_api_key()
    if not api_key:
        raise SystemExit("Could not find the Firebase web API key; pass --api-key.")

    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    token = sign_in(api_key, args.email)

    with httpx.Client(base_url=args.base_url.rstrip("/"),
                      headers={"Authorization": f"Bearer {token}"}, timeout=60) as client:
        sales = fetch_flagged(client, args.outlet_id, since, flagged_only=not args.all)

        window = "the last 24 hours" if args.days == 1 else f"the last {args.days} days"
        print(f"\nPrice-variance review — {window}")
        print(f"Outlet {args.outlet_id}\n")

        flagged = [s for s in sales if s["price_variance_flagged"]]
        if args.all:
            print(f"  {len(sales)} sale(s) total, {len(flagged)} flagged\n")
        if not flagged:
            print("  No flagged sales. Nothing to review.\n")
            return

        total_gap = Decimal(0)
        for sale in flagged:
            detail = fetch_detail(client, args.outlet_id, sale["id"])
            when = datetime.fromisoformat(detail["created_at"].replace("Z", "+00:00"))
            print(f"  {when:%Y-%m-%d %H:%M}  GHS {detail['total_amount']:>9}  "
                  f"{detail['payment_method'] or '(no payment method)'}")
            for line in detail["line_items"]:
                if line["price_variance_flagged"]:
                    print(describe_line(line))
                    gap = money(line["unit_price"]) - money(line["catalog_unit_price_at_sale"])
                    total_gap += gap * line["quantity"]
            print()

        sign = "less" if total_gap < 0 else "more"
        print(f"  {len(flagged)} flagged sale(s). Net GHS {abs(total_gap)} {sign} than catalog prices.\n")
        print("  If you changed a price recently, a stale till cache explains it and it will")
        print("  settle within a day. If you did NOT, look at the device.\n")


if __name__ == "__main__":
    main()
