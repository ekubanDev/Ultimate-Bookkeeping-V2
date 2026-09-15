"""packages/shared-types must agree with the Pydantic schemas it mirrors.

The wire contract is hand-written twice, in two languages: `SaleRequest` in
packages/shared-types/sale.ts and `SaleCreateRequest` in app/schemas.py.
Nothing generated one from the other, nothing compared them, and by the time
code review looked they had already drifted on FIVE fields — TypeScript told
useSubmitSale.js that payment_method, discount_type, discount_value,
tax_amount and device_recorded_at were mandatory while the server they were
being sent to accepted a body without any of them.

It never showed up at runtime because the client happens to send all five.
That is the failure mode worth naming: two definitions of one contract stay
"correct" for exactly as long as nobody relies on the difference.

The team already solved this class of problem for the database — CI runs
`alembic check` and fails on model/migration drift — and simply never
applied the same idea at the frontend/backend boundary. This is that check.

WHY PARSE THE .ts RATHER THAN GENERATE IT: generating the types from OpenAPI
is the better long-term answer (Kwame's recommendation, and worth doing
before /apps/admin becomes a second consumer). This test is the cheap
version that can land today and makes the drift impossible to reintroduce
silently in the meantime. It deliberately only compares FIELD NAMES and
REQUIRED-NESS — not types, not formats — because that is the part a regex
can check honestly. It is a drift alarm, not a type checker.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.main import create_app

SALE_TS = Path(__file__).resolve().parents[3] / "packages" / "shared-types" / "sale.ts"


def _openapi_component(name: str) -> dict:
    # docs_url is disabled by default (see app/main.py), but .openapi() builds
    # the schema regardless of whether it is served over HTTP.
    schema = create_app().openapi()
    components = schema["components"]["schemas"]
    assert name in components, f"{name} missing from the OpenAPI schema"
    return components[name]


def _ts_interface_fields(source: str, interface: str) -> dict[str, bool]:
    """Field name -> is_required, for one TS interface.

    Strips comments first so a `foo?: string` mentioned in prose can't be
    mistaken for a declaration.
    """
    match = re.search(rf"export interface {interface} \{{(.*?)\n\}}", source, re.S)
    assert match, f"interface {interface} not found in {SALE_TS.name}"
    body = match.group(1)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    body = re.sub(r"//.*", "", body)

    fields: dict[str, bool] = {}
    for line in body.splitlines():
        declaration = re.match(r"^\s*(\w+)(\??):", line)
        if declaration:
            fields[declaration.group(1)] = declaration.group(2) != "?"
    assert fields, f"no fields parsed from {interface} — has the file's shape changed?"
    return fields


@pytest.mark.parametrize(
    ("ts_interface", "pydantic_model"),
    [("SaleRequest", "SaleCreateRequest"), ("SaleLineItemRequest", "SaleLineItemIn")],
)
def test_shared_types_match_the_api_schema(ts_interface: str, pydantic_model: str):
    ts_fields = _ts_interface_fields(SALE_TS.read_text(), ts_interface)
    component = _openapi_component(pydantic_model)
    server_fields = set(component.get("properties", {}))
    server_required = set(component.get("required", []))

    assert set(ts_fields) == server_fields, (
        f"{ts_interface} and {pydantic_model} declare different fields.\n"
        f"  only in TypeScript: {sorted(set(ts_fields) - server_fields)}\n"
        f"  only on the server: {sorted(server_fields - set(ts_fields))}"
    )

    mismatched = {
        field: (
            "required in TS, optional on the server"
            if required
            else "optional in TS, required on the server"
        )
        for field, required in ts_fields.items()
        if required != (field in server_required)
    }
    assert not mismatched, (
        f"{ts_interface} and {pydantic_model} disagree on which fields are required:\n"
        + "\n".join(f"  {f}: {why}" for f, why in sorted(mismatched.items()))
        + f"\n\nFix whichever side is wrong — {SALE_TS} or app/schemas.py — rather than "
        "editing this test. They describe one wire contract and clients rely on both."
    )
