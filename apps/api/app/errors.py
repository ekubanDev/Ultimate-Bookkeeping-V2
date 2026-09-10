"""Standard error envelope (api-contracts.md §1) and the AppError exception
that routers raise to produce it.
"""
from __future__ import annotations

from decimal import Decimal


class AppError(Exception):
    def __init__(self, *, code: str, message: str, retryable: bool, status_code: int = 400):
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status_code = status_code
        super().__init__(message)


def format_money(value: Decimal) -> str:
    """Serialize a Decimal to a 2dp string for the wire — never a float."""
    return str(value.quantize(Decimal("0.01")))
