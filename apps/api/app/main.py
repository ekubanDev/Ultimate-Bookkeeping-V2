"""App factory, router registration, error-envelope exception handlers."""
from __future__ import annotations

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse

from app.errors import AppError
from app.rate_limit import limiter
from app.routers import expenses, me, products, sales, stock


def create_app() -> FastAPI:
    app = FastAPI(title="Ultimate Bookkeeping API", version="0.1.0")

    app.state.limiter = limiter

    app.include_router(sales.router)
    app.include_router(stock.router)
    app.include_router(expenses.router)
    app.include_router(me.router)
    app.include_router(products.router)

    @app.exception_handler(RateLimitExceeded)
    async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
        # Standard error envelope (api-contracts.md §1), NOT slowapi's
        # default `{"error": "Rate limit exceeded: ..."}` shape. `retryable`
        # is deliberately `True`: the offline queue (packages/offline-queue)
        # branches on this field, and a rate-limited offline-eligible write
        # (sale/stock-adjustment/expense) must be re-queued and retried with
        # backoff — never surfaced to the cashier as a failed transaction.
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={
                "error": {
                    "code": "RATE_LIMITED",
                    "message": "Too many requests. Please retry shortly.",
                    "retryable": True,
                }
            },
        )

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "retryable": exc.retryable,
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Wraps FastAPI/pydantic's default 422 body into the standard error
        # envelope (api-contracts.md §1) instead of the default
        # `{"detail": [...]}` shape.
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "Request body failed validation.",
                    "retryable": False,
                    "details": jsonable_encoder(exc.errors()),
                }
            },
        )

    return app


app = create_app()
