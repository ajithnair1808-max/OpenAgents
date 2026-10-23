"""Tests for structured error responses.

@fix-author: KiloClaw
@fix-date: 2026-06-07
@runtime: os=Linux, arch=x64, working_dir=/root/.openclaw/workspace/clanker_repo/api, shell=python3
"""

import pytest
from fastapi.testclient import TestClient

from .main import app
from .errors import (
    ERROR_NOT_FOUND,
    ERROR_VALIDATION,
    ERROR_AUTH_FAILED,
    ERROR_RATE_LIMITED,
    ERROR_INTERNAL,
    format_error,
)


@pytest.fixture
def client():
    return TestClient(app)


def test_health_endpoint_returns_request_id(client):
    """Health endpoint includes request ID in response."""
    response = client.get("/health")
    assert response.status_code == 200
    assert "X-Request-ID" in response.headers


def test_structured_error_response_schema(client):
    """Error responses follow the standard schema."""
    response = client.get("/agents/nonexistent-agent")
    assert response.status_code == 404

    data = response.json()
    assert "code" in data
    assert "message" in data
    assert data["code"] == ERROR_NOT_FOUND
    assert "request_id" in data


def test_validation_error_has_field_details(client):
    """Validation errors include field-level details."""
    # Test with invalid query parameter
    response = client.get("/agents?limit=1000")  # exceeds max of 100
    assert response.status_code == 422

    data = response.json()
    assert data["code"] == ERROR_VALIDATION
    assert "fields" in data.get("details", {})


def test_rate_limit_returns_structured_error(client):
    """Rate limit exceeded returns structured error with retry_after."""
    # This test verifies the error format is correct
    from .errors import format_error
    error = format_error(
        code=ERROR_RATE_LIMITED,
        message="Rate limit exceeded",
        details={"retry_after": 30},
        request_id="test-req-123",
    )

    assert error["code"] == ERROR_RATE_LIMITED
    assert error["message"] == "Rate limit exceeded"
    assert error["details"]["retry_after"] == 30
    assert error["request_id"] == "test-req-123"


def test_error_codes_are_defined():
    """All required error codes are defined."""
    assert ERROR_NOT_FOUND == "NOT_FOUND"
    assert ERROR_VALIDATION == "VALIDATION_ERROR"
    assert ERROR_AUTH_FAILED == "AUTH_FAILED"
    assert ERROR_RATE_LIMITED == "RATE_LIMITED"
    assert ERROR_INTERNAL == "INTERNAL_ERROR"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])