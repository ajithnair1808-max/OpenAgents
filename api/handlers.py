"""Custom exception handlers for structured error responses.

@fix-author: KiloClaw
@fix-date: 2026-06-07
@runtime: os=Linux, arch=x64, working_dir=/root/.openclaw/workspace/clanker_repo/api, shell=python3
"""

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .errors import (
    ERROR_NOT_FOUND,
    ERROR_VALIDATION,
    ERROR_AUTH_FAILED,
    ERROR_RATE_LIMITED,
    ERROR_INTERNAL,
    ERROR_BAD_REQUEST,
    format_error,
)


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Handle Pydantic validation errors with structured response."""
    request_id = getattr(request.state, "request_id", None)

    # Extract field-level errors
    field_errors = []
    for error in exc.errors():
        field_path = ".".join(str(loc) for loc in error["loc"])
        field_errors.append({
            "field": field_path,
            "type": error["type"],
            "message": error.get("msg", ""),
            "input": error.get("input"),
        })

    return JSONResponse(
        status_code=422,
        content=format_error(
            code=ERROR_VALIDATION,
            message="Request validation failed",
            details={"fields": field_errors},
            request_id=request_id,
        ),
    )


async def http_exception_handler(request: Request, exc: HTTPException):
    """Handle HTTP exceptions with structured error response."""
    request_id = getattr(request.state, "request_id", None)

    # Map status codes to error codes
    code_map = {
        400: ERROR_BAD_REQUEST,
        401: ERROR_AUTH_FAILED,
        403: ERROR_AUTH_FAILED,
        404: ERROR_NOT_FOUND,
        429: ERROR_RATE_LIMITED,
        500: ERROR_INTERNAL,
    }

    error_code = code_map.get(exc.status_code, ERROR_BAD_REQUEST)

    return JSONResponse(
        status_code=exc.status_code,
        content=format_error(
            code=error_code,
            message=str(exc.detail),
            details=None,
            request_id=request_id,
        ),
        headers=exc.headers,
    )


async def generic_exception_handler(request: Request, exc: Exception):
    """Handle unexpected errors with generic internal error response."""
    request_id = getattr(request.state, "request_id", None)

    return JSONResponse(
        status_code=500,
        content=format_error(
            code=ERROR_INTERNAL,
            message="An unexpected error occurred",
            details={"error": type(exc).__name__},
            request_id=request_id,
        ),
    )


def register_error_handlers(app: FastAPI):
    """Register all custom exception handlers."""
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(Exception, generic_exception_handler)