from __future__ import annotations

import os

from fastapi.testclient import TestClient

from server.main import app


def test_runtime_identity_exposes_launcher_token(monkeypatch):
    monkeypatch.setenv("SIMULATEUR_INSTANCE_TOKEN", "launcher-test-token")

    response = TestClient(app).get("/runtime/identity")

    assert response.status_code == 200
    payload = response.json()
    assert payload["instanceToken"] == "launcher-test-token"
    assert payload["processId"] == os.getpid()
    assert payload["parentProcessId"] > 0
    assert payload["processStartedAt"]
