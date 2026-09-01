"""App factory, router registration, error-envelope exception handlers."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse

from app.errors import AppError
from app.routers import expenses, sales, stock


def create_app() -> FastAPI:
    app = FastAPI(title="Ultimate Bookkeeping API", version="0.1.0")

    app.include_router(sales.router)
    app.include_router(stock.router)
    app.include_router(expenses.router)

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
