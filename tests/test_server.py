from __future__ import annotations

import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import server.app as app_module
from server.main import app as main_app


@pytest.fixture(autouse=True)
def clear_download_jobs():
    with app_module.DOWNLOAD_LOCK:
        app_module.DOWNLOAD_JOBS.clear()
        app_module.DOWNLOAD_CANCEL_EVENTS.clear()
    yield


def test_api_entrypoints_expose_local_lidar_routes_once():
    assert app_module.app is main_app
    matching_routes = [
        route
        for route in app_module.app.routes
        if getattr(route, "path", None) == "/local-lidar/files"
    ]
    assert len(matching_routes) == 1
    assert TestClient(app_module.app).get("/local-lidar/files").status_code == 200


def test_parse_range_header_variants():
    assert app_module.parse_range_header(None, 10) is None
    assert app_module.parse_range_header("bytes=2-5", 10) == (2, 5)
    assert app_module.parse_range_header("bytes=7-", 10) == (7, 9)
    assert app_module.parse_range_header("bytes=-3", 10) == (7, 9)
    assert app_module.parse_range_header("bytes=0-99", 10) == (0, 9)


@pytest.mark.parametrize("header", ["items=0-2", "bytes=-0", "bytes=10-11", "bytes=5-2"])
def test_parse_range_header_rejects_invalid_ranges(header: str):
    with pytest.raises(HTTPException) as exc_info:
        app_module.parse_range_header(header, 10)
    assert exc_info.value.status_code == 416
    assert exc_info.value.headers == {"Content-Range": "bytes */10"}


def test_file_endpoint_supports_partial_get_and_head(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    lidar_dir = data_dir / "lidar"
    lidar_dir.mkdir(parents=True)
    file_path = lidar_dir / "sample.copc.laz"
    file_path.write_bytes(b"0123456789")
    monkeypatch.setattr(app_module, "DATA_DIR", data_dir)

    client = TestClient(app_module.app)
    response = client.get("/files/lidar/sample.copc.laz", headers={"Range": "bytes=2-5"})
    assert response.status_code == 206
    assert response.content == b"2345"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert response.headers["content-length"] == "4"

    head = client.head("/files/lidar/sample.copc.laz", headers={"Range": "bytes=0-3"})
    assert head.status_code == 206
    assert head.content == b""
    assert head.headers["content-range"] == "bytes 0-3/10"
    assert head.headers["content-length"] == "4"


def test_download_job_reuses_cached_file(tmp_path, monkeypatch):
    lidar_dir = tmp_path / "lidar"
    lidar_dir.mkdir()
    filename = "sample.copc.laz"
    (lidar_dir / filename).write_bytes(b"LASFcached")
    monkeypatch.setattr(app_module, "LIDAR_DIR", lidar_dir)

    client = TestClient(app_module.app)
    response = client.post(
        "/lidar/downloads",
        json={"url": f"{app_module.LIDAR_DOWNLOAD_PREFIX}{filename}"},
    )
    assert response.status_code == 202
    job_id = response.json()["id"]

    deadline = time.time() + 2
    payload = None
    while time.time() < deadline:
        payload = client.get(f"/lidar/downloads/{job_id}").json()
        if payload["status"] == "completed":
            break
        time.sleep(0.02)

    assert payload is not None
    assert payload["status"] == "completed"
    assert payload["phase"] == "cached"
    assert payload["path"] == f"/files/lidar/{filename}"
    assert payload["bytesDownloaded"] == len(b"LASFcached")


def test_download_url_restrictions():
    with pytest.raises(HTTPException) as wrong_host:
        app_module.validate_download_url("https://example.com/sample.copc.laz")
    assert wrong_host.value.status_code == 400

    with pytest.raises(HTTPException) as not_copc:
        app_module.validate_download_url(f"{app_module.LIDAR_DOWNLOAD_PREFIX}sample.laz")
    assert not_copc.value.status_code == 400
