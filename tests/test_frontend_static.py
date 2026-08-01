from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.frontend import mount_frontend


def test_mount_frontend_serves_built_pages_and_keeps_api_routes(tmp_path):
    dist = tmp_path / "dist"
    laz_perf = dist / "laz-perf"
    laz_perf.mkdir(parents=True)
    (dist / "index.html").write_text("<h1>Map</h1>", encoding="utf-8")
    (dist / "lidar.html").write_text("<h1>LiDAR</h1>", encoding="utf-8")
    (laz_perf / "laz-perf.wasm").write_bytes(b"wasm")

    app = FastAPI()

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    assert mount_frontend(app, dist) is True
    client = TestClient(app)

    assert client.get("/health").json() == {"status": "ok"}
    assert "Map" in client.get("/").text
    assert "LiDAR" in client.get("/lidar.html").text
    assert client.get("/laz-perf/laz-perf.wasm").content == b"wasm"


def test_mount_frontend_skips_missing_build(tmp_path):
    assert mount_frontend(FastAPI(), tmp_path / "missing") is False
