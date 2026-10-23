import sys
from pathlib import Path

# The API is run as `cd api && uvicorn main:app`, so put `api/` on the path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=False)


def _assert_structured(body: dict, code: str):
    assert set(body.keys()) == {"error"}
    err = body["error"]
    assert err["code"] == code
    assert isinstance(err["message"], str) and err["message"]
    assert "details" in err
    assert isinstance(err["request_id"], str) and err["request_id"]
    return err


def test_agent_not_found_has_specific_code():
    r = client.get("/agents/does-not-exist")
    assert r.status_code == 404
    err = _assert_structured(r.json(), "AGENT_NOT_FOUND")
    assert r.headers["X-Request-ID"] == err["request_id"]


def test_task_not_found_has_specific_code():
    r = client.get("/tasks/999999")
    assert r.status_code == 404
    _assert_structured(r.json(), "TASK_NOT_FOUND")


def test_validation_error_lists_fields():
    r = client.get("/tasks/not-an-int")
    assert r.status_code == 422
    err = _assert_structured(r.json(), "VALIDATION_ERROR")
    assert isinstance(err["details"], list) and err["details"]
    assert {"field", "message", "type"} <= set(err["details"][0].keys())


def test_unknown_route_uses_not_found_code():
    r = client.get("/no-such-route")
    assert r.status_code == 404
    _assert_structured(r.json(), "NOT_FOUND")


def test_request_id_is_echoed_when_supplied():
    r = client.get("/agents/missing", headers={"X-Request-ID": "req-abc-123"})
    assert r.json()["error"]["request_id"] == "req-abc-123"
    assert r.headers["X-Request-ID"] == "req-abc-123"


def test_request_ids_are_unique_when_not_supplied():
    a = client.get("/agents/missing").json()["error"]["request_id"]
    b = client.get("/agents/missing").json()["error"]["request_id"]
    assert a != b


def test_unhandled_exception_returns_500_without_leaking():
    @app.get("/__boom")
    async def boom():
        raise RuntimeError("secret internal detail")

    r = client.get("/__boom")
    assert r.status_code == 500
    err = _assert_structured(r.json(), "INTERNAL_ERROR")
    assert "secret" not in r.text
    assert err["message"] == "Internal server error"


def test_success_responses_are_unchanged():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
