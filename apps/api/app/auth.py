"""Auth dependency stub.

Resolves the current user (id, role, outlet_id) from the `Authorization:
Bearer <token>` header, per api-contracts.md §1: "Auth: Firebase ID token ...
verified server-side; role (`admin`/`outlet_manager`) and `outlet_id` resolved
from the `users` table, never trusted from the request body."

Real Firebase ID token verification (firebase_admin.auth.verify_id_token) is a
later task. `verify_firebase_token` below is the clearly-marked seam: it's the
only place a real implementation needs to slot in. It deliberately raises
NotImplementedError rather than trusting an unverified token, so nothing can
accidentally ship without real verification. Tests override `get_current_user`
wholesale via `app.dependency_overrides`.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import User


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    role: str
    outlet_id: uuid.UUID | None


def verify_firebase_token(token: str) -> str:
    """SEAM: verify a Firebase ID token and return the Firebase UID (`sub`).

    Not implemented yet — wire up `firebase_admin.auth.verify_id_token` here
    before any real deployment. Left raising on purpose: an unverified token
    must never be trusted for role/outlet_id resolution.
    """
    raise NotImplementedError(
        "Firebase ID token verification is not implemented yet. "
        "See api-contracts.md §1. Override `get_current_user` for tests/local dev."
    )


async def get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
        )
    token = authorization.removeprefix("Bearer ").strip()
    uid = verify_firebase_token(token)

    user = (await db.execute(select(User).where(User.id == uuid.UUID(uid)))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user")
    return CurrentUser(id=user.id, role=user.role, outlet_id=user.outlet_id)
