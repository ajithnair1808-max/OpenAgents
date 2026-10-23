"""Structured error responses for the OpenAgents API.

Every error returned by the API has the same JSON body:

    {
        "error": {
            "code": "AGENT_NOT_FOUND",
            "message": "Agent not found",
            "details": null,
            "request_id": "3f0c..."
        }
    }

The request ID is taken from the incoming ``X-Request-ID`` header when present
(so clients can correlate), otherwise a new UUID is generated. It is also
returned in the ``X-Request-ID`` response header.
"""

import logging
import uuid
from enum import Enum
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("openagents.api")

REQUEST_ID_HEADER = "X-Request-ID"


class ErrorCode(str, Enum):
    BAD_REQUEST = "BAD_REQUEST"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    AGENT_NOT_FOUND = "AGENT_NOT_FOUND"
    TASK_NOT_FOUND = "TASK_NOT_FOUND"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# Fallback mapping for plain HTTPException / Starlette errors.
_STATUS_TO_CODE = {
    400: ErrorCode.BAD_REQUEST,
    401: ErrorCode.UNAUTHORIZED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    422: ErrorCode.VALIDATION_ERROR,
    429: ErrorCode.RATE_LIMITED,
}


class ErrorBody(BaseModel):
    code: str
    message: str
    details: Optional[Any] = None
    request_id: str


class ErrorResponse(BaseModel):
    error: ErrorBody


class APIException(Exception):
    """Raise this to return a structured error with a specific code."""

    def __init__(
        self,
        status_code: int,
        code: ErrorCode,
        message: str,
        details: Any = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def get_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", None) or str(uuid.uuid4())


def _error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    details: Any = None,
    headers: Optional[dict] = None,
) -> JSONResponse:
    request_id = get_request_id(request)
    body = ErrorResponse(
        error=ErrorBody(
            code=code, message=message, details=details, request_id=request_id
        )
    )
    response_headers = dict(headers or {})
    response_headers[REQUEST_ID_HEADER] = request_id
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(mode="json"),
        headers=response_headers,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Attach the request-ID middleware and all error handlers to ``app``."""

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request.state.request_id = request.headers.get(REQUEST_ID_HEADER) or str(
            uuid.uuid4()
        )
        response = await call_next(request)
        response.headers.setdefault(REQUEST_ID_HEADER, request.state.request_id)
        return response

    @app.exception_handler(APIException)
    async def api_exception_handler(request: Request, exc: APIException):
        return _error_response(
            request, exc.status_code, exc.code.value, exc.message, exc.details
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        code = _STATUS_TO_CODE.get(exc.status_code, ErrorCode.INTERNAL_ERROR)
        return _error_response(
            request,
            exc.status_code,
            code.value,
            str(exc.detail),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ):
        details = [
            {
                "field": ".".join(str(part) for part in err.get("loc", ())),
                "message": err.get("msg", ""),
                "type": err.get("type", ""),
            }
            for err in exc.errors()
        ]
        return _error_response(
            request,
            422,
            ErrorCode.VALIDATION_ERROR.value,
            "Request validation failed",
            details,
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        request_id = get_request_id(request)
        logger.exception("Unhandled error (request_id=%s)", request_id)
        # Never leak internal error details to the client.
        return _error_response(
            request,
            500,
            ErrorCode.INTERNAL_ERROR.value,
            "Internal server error",
        )
