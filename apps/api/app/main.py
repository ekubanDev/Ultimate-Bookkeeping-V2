"""App factory, router registration, error-envelope exception handlers."""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse

from app.errors import AppError
from app.rate_limit import limiter
from app.routers import expenses, me, products, sales, stock


logger = logging.getLogger(__name__)


def _docs_enabled() -> bool:
    """Interactive API docs: OFF unless explicitly switched on.

    The deployed Cloud Run service must be --allow-unauthenticated for
    Firebase Hosting's rewrite to reach it (Hosting attaches no identity
    token — see .github/workflows/deploy.yml), so its *.run.app URL is
    internet-reachable. FastAPI's defaults would serve /docs, /redoc and
    /openapi.json there to anyone, unauthenticated: found live during code
    review, returning the full schema of all six endpoints.

    It leaks no data — every endpoint still requires a verified Firebase
    token — but it hands over the complete API shape for free, and there is
    no reason for a POS backend to publish that. Off by default, opt in with
    ENABLE_API_DOCS=true for local development.
    """
    return os.environ.get("ENABLE_API_DOCS", "").strip().lower() in ("1", "true", "yes")


def create_app() -> FastAPI:
    docs = _docs_enabled()
    app = FastAPI(
        title="Ultimate Bookkeeping API",
        version="0.1.0",
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )

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

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
        # Catch-all, so that EVERY response from this API carries the standard
        # envelope (api-contracts.md §1). Without it, anything not matched by
        # the handlers above — a dead pool connection, a Cloud SQL failover, a
        # genuine bug — falls through to Starlette's default and returns a
        # bare `Internal Server Error` string.
        #
        # That matters beyond tidiness: packages/offline-queue branches on
        # `retryable` to decide whether a queued sale should be retried or
        # surfaced to the cashier as failed. An unparseable body means it can
        # read neither, so a transient database blip could be treated as a
        # permanent failure on a sale that was never recorded.
        #
        # retryable=True is the deliberate choice here: an unhandled server
        # error is far more often transient (connection, timeout, deploy
        # window) than a permanent rejection of this particular intent, and
        # the client_id contract makes a retry safe even if the original did
        # commit — a replay returns the original answer rather than
        # double-writing (design.md §3.4).
        #
        # The message is deliberately generic; the detail goes to the logs,
        # not to the client. exc_info=True so Cloud Logging captures the
        # traceback, which is the only place it now appears.
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Something went wrong on our side. Please try again.",
                    "retryable": True,
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
