from __future__ import annotations

import os

from fastapi.testclient import TestClient

import server.local_files as local_files
from server.main import app


def test_list_local_files_orders_latest_first(tmp_path, monkeypatch):
    lidar_dir = tmp_path / "lidar"
    lidar_dir.mkdir()
    older = lidar_dir / "older.copc.laz"
    latest = lidar_dir / "latest.copc.laz"
    older.write_bytes(b"LASF-old")
    latest.write_bytes(b"LASF-new")
    os.utime(older, (100, 100))
    os.utime(latest, (200, 200))
    monkeypatch.setattr(local_files, "LIDAR_DIR", lidar_dir)

    response = TestClient(app).get("/local-lidar/files")

    assert response.status_code == 200
    files = response.json()["files"]
    assert [item["name"] for item in files] == ["latest.copc.laz", "older.copc.laz"]
    assert files[0]["path"] == "/files/lidar/latest.copc.laz"


def test_import_local_copc_streams_file_to_lidar_directory(tmp_path, monkeypatch):
    lidar_dir = tmp_path / "lidar"
    lidar_dir.mkdir()
    monkeypatch.setattr(local_files, "LIDAR_DIR", lidar_dir)
    payload = b"LASF-local-copc"

    response = TestClient(app).post(
        "/local-lidar/import",
        headers={"X-Filename": "ma%20dalle.copc.laz", "Content-Type": "application/octet-stream"},
        content=payload,
    )

    assert response.status_code == 201
    assert response.json()["name"] == "ma dalle.copc.laz"
    assert (lidar_dir / "ma dalle.copc.laz").read_bytes() == payload


def test_import_rejects_non_copc_file(tmp_path, monkeypatch):
    lidar_dir = tmp_path / "lidar"
    lidar_dir.mkdir()
    monkeypatch.setattr(local_files, "LIDAR_DIR", lidar_dir)

    response = TestClient(app).post(
        "/local-lidar/import",
        headers={"X-Filename": "sample.laz"},
        content=b"LASF",
    )

    assert response.status_code == 400
    assert not list(lidar_dir.iterdir())


def test_open_folder_uses_fixed_lidar_directory(tmp_path, monkeypatch):
    lidar_dir = tmp_path / "lidar"
    opened: list[str] = []
    monkeypatch.setattr(local_files, "LIDAR_DIR", lidar_dir)
    monkeypatch.setattr(local_files, "open_lidar_folder", lambda: opened.append(str(lidar_dir)))

    response = TestClient(app).post("/local-lidar/open-folder")

    assert response.status_code == 202
    assert opened == [str(lidar_dir)]
    assert lidar_dir.is_dir()
