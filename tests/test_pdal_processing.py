from __future__ import annotations

import csv
import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.testclient import TestClient

import server.pdal_processing as pdal_processing
from server.main import app


def test_bounds_expression_normalizes_bbox():
    bbox = pdal_processing.BBox4326(minLon=2.2, minLat=48.9, maxLon=2.1, maxLat=48.8)
    assert pdal_processing.bounds_expression(bbox) == "([2.100000000000,2.200000000000],[48.800000000000,48.900000000000])"


def test_resolve_local_lidar_path_rejects_non_local_paths():
    try:
        pdal_processing.resolve_local_lidar_path("https://example.com/tile.copc.laz")
    except HTTPException as exc:
        assert exc.status_code == 400
    else:  # pragma: no cover - sécurité du test
        raise AssertionError("Le chemin distant aurait dû être refusé")


def test_processed_pipeline_contains_crop_clean_and_copc_writer(tmp_path):
    source = tmp_path / "tile.copc.laz"
    source.write_bytes(b"LASF")
    request = pdal_processing.ProcessRequest(
        path="/files/lidar/tile.copc.laz",
        bbox={"minLon": 1.0, "minLat": 2.0, "maxLon": 3.0, "maxLat": 4.0},
        profile="balanced",
    )

    pipeline = pdal_processing.processed_copc_pipeline(source, tmp_path / "selection.copc.laz", request)["pipeline"]

    assert [stage["type"] for stage in pipeline] == [
        "readers.copc",
        "filters.reprojection",
        "filters.crop",
        "filters.reprojection",
        "filters.expression",
        "filters.decimation",
        "writers.copc",
    ]
    assert pipeline[2]["bounds"] == "([1.000000000000,3.000000000000],[2.000000000000,4.000000000000])"
    assert pipeline[-1]["a_srs"] == "EPSG:2154"


def test_generate_lidar_building_boxes_uses_only_lidar_classes(tmp_path):
    csv_path = tmp_path / "building_points.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["X", "Y", "Z", "Classification"])
        writer.writeheader()
        for x in range(10):
            for y in range(10):
                writer.writerow({"X": 700000 + x, "Y": 6600000 + y, "Z": 35 + (x % 2), "Classification": 6})
        for x in range(-5, 15):
            for y in range(-5, 15):
                writer.writerow({"X": 700000 + x, "Y": 6600000 + y, "Z": 20, "Classification": 2})

    boxes = pdal_processing.generate_lidar_building_boxes(csv_path, "balanced")

    assert len(boxes) == 1
    box = boxes[0]
    assert box["source"] == "lidar-classification-6"
    assert box["minZ"] == 20
    assert box["maxZ"] >= 35
    assert box["points"] == 100


def test_pdal_status_endpoint_reports_availability(monkeypatch):
    monkeypatch.setattr(pdal_processing.shutil, "which", lambda name: "C:/OSGeo4W/bin/pdal.exe" if name == "pdal" else None)

    response = TestClient(app).get("/lidar/pdal/status")

    assert response.status_code == 200
    assert response.json()["available"] is True
    assert "balanced" in response.json()["profiles"]


def test_start_process_reuses_manifest_cache(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    source_dir = data_dir / "lidar"
    processed_dir = data_dir / "processed"
    source_dir.mkdir(parents=True)
    processed_dir.mkdir()
    source = source_dir / "tile.copc.laz"
    source.write_bytes(b"LASF")

    monkeypatch.setattr(pdal_processing, "DATA_DIR", data_dir)
    monkeypatch.setattr(pdal_processing, "PROCESSED_DIR", processed_dir)

    request_payload = {
        "path": "/files/lidar/tile.copc.laz",
        "bbox": {"minLon": 1, "minLat": 2, "maxLon": 3, "maxLat": 4},
        "profile": "fluid",
    }
    output_dir = pdal_processing.output_directory(source, pdal_processing.ProcessRequest(**request_payload))
    output_dir.mkdir(parents=True)
    (output_dir / "selection.copc.laz").write_bytes(b"LASF processed")
    (output_dir / "buildings.json").write_text('{"buildings": []}', encoding="utf-8")
    (output_dir / "manifest.json").write_text(
        '{"path":"/files/processed/test/selection.copc.laz","buildingsPath":"/files/processed/test/buildings.json","buildings":[],"buildingCount":0,"profile":"fluid"}',
        encoding="utf-8",
    )

    response = TestClient(app).post("/lidar/processes", json=request_payload)

    assert response.status_code == 202
    assert response.json()["status"] == "completed"
    assert response.json()["phase"] == "cached"
