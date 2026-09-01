from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select

from app.models import Expense


def _expense_payload(seed, *, client_id="exp-1", amount="50.00", category="utilities", note="generator fuel"):
    return {
        "client_id": client_id,
        "outlet_id": str(seed["outlet_id"]),
        "amount": amount,
        "category": category,
        "note": note,
        "device_recorded_at": "2026-08-31T18:42:03Z",
    }


async def test_happy_path_creates_expense(client):
    seed = client.seed
    resp = await client.post("/api/v1/expenses", json=_expense_payload(seed))

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "recorded"
    assert body["amount"] == "50.00"
    assert body["client_id"] == "exp-1"
    assert body["idempotent_replay"] is False
    assert "id" in body and "created_at" in body

    async with client.session_factory() as session:
        expense = (await session.execute(select(Expense).where(Expense.client_id == "exp-1"))).scalar_one()

    assert expense.amount == Decimal("50.00")
    assert expense.category == "utilities"
    assert expense.note == "generator fuel"
    assert expense.outlet_id == seed["outlet_id"]


async def test_idempotent_replay_does_not_duplicate_expense(client):
    seed = client.seed
    payload = _expense_payload(seed, client_id="exp-replay")

    first = await client.post("/api/v1/expenses", json=payload)
    assert first.status_code == 201
    first_body = first.json()

    second = await client.post("/api/v1/expenses", json=payload)
    assert second.status_code == 200
    second_body = second.json()

    assert second_body["idempotent_replay"] is True
    assert second_body["id"] == first_body["id"]
    assert second_body["amount"] == first_body["amount"]

    async with client.session_factory() as session:
        expenses = (
            (await session.execute(select(Expense).where(Expense.client_id == "exp-replay"))).scalars().all()
        )
    assert len(expenses) == 1


async def test_rejects_float_money(client):
    seed = client.seed
    payload = _expense_payload(seed, client_id="exp-float")
    payload["amount"] = 50.0  # float, not a string

    resp = await client.post("/api/v1/expenses", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_three_decimal_places(client):
    seed = client.seed
    payload = _expense_payload(seed, client_id="exp-3dp", amount="50.005")

    resp = await client.post("/api/v1/expenses", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_negative_amount(client):
    seed = client.seed
    payload = _expense_payload(seed, client_id="exp-neg", amount="-5.00")

    resp = await client.post("/api/v1/expenses", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_missing_client_id(client):
    seed = client.seed
    payload = _expense_payload(seed)
    del payload["client_id"]

    resp = await client.post("/api/v1/expenses", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_rejects_empty_category(client):
    seed = client.seed
    payload = _expense_payload(seed, client_id="exp-nocat", category="")

    resp = await client.post("/api/v1/expenses", json=payload)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
