from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

import server.scene_manifest as scene_manifest
from server.main import app


ROOT = Path(__file__).resolve().parents[1]
LIDAR_HTML = ROOT / "web" / "lidar.html"
SIMULATION_SOURCE = ROOT / "web" / "src" / "simulation-mode.ts"
BOOTSTRAP_SOURCE = ROOT / "web" / "src" / "lidar-bootstrap.ts"
VIEWER_CSS = ROOT / "web" / "src" / "lidar-viewer.css"


def create_legacy_scene(tmp_path: Path) -> tuple[Path, str, str]:
    data_dir = tmp_path / "data"
    output_dir = data_dir / "processed" / "abc123"
    output_dir.mkdir(parents=True)
    copc_path = "/files/processed/abc123/selection.copc.laz"
    buildings_path = "/files/processed/abc123/buildings.json"
    (output_dir / "selection.copc.laz").write_bytes(b"LASF processed")
    (output_dir / "buildings.json").write_text(
        json.dumps(
            {
                "buildings": [
                    {
                        "id": "building-1",
                        "crs": "EPSG:2154",
                        "minX": 700000,
                        "minY": 6600000,
                        "minZ": 20,
                        "maxX": 700010,
                        "maxY": 6600012,
                        "maxZ": 35,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (output_dir / "manifest.json").write_text(
        json.dumps(
            {
                "path": copc_path,
                "buildingsPath": buildings_path,
                "buildingCount": 1,
                "bbox": {"minLon": 2.1, "minLat": 48.8, "maxLon": 2.2, "maxLat": 48.9},
                "profile": "balanced",
                "pointBudgetHint": 1_800_000,
                "tool": "pdal",
            }
        ),
        encoding="utf-8",
    )
    return data_dir, copc_path, buildings_path


def test_scene_manifest_upgrades_legacy_pdal_outputs(tmp_path, monkeypatch):
    data_dir, copc_path, buildings_path = create_legacy_scene(tmp_path)
    monkeypatch.setattr(scene_manifest, "DATA_DIR", data_dir)

    manifest = scene_manifest.scene_manifest_for(
        copc_path=copc_path,
        buildings_path=buildings_path,
        profile="balanced",
    )

    assert manifest["schemaVersion"] == 1
    assert {artifact["id"] for artifact in manifest["artifacts"]} == {
        "points.cleaned",
        "terrain.ign",
        "buildings.pdal",
    }
    assert manifest["presets"]["simulation"]["visibleArtifacts"] == [
        "points.cleaned",
        "terrain.ign",
        "buildings.pdal",
    ]
    assert manifest["runs"][0]["id"] == "pdal"
    assert manifest["runs"][0]["metrics"]["buildingCount"] == 1


def test_scene_manifest_endpoint_is_available(tmp_path, monkeypatch):
    data_dir, copc_path, buildings_path = create_legacy_scene(tmp_path)
    monkeypatch.setattr(scene_manifest, "DATA_DIR", data_dir)

    response = TestClient(app).get(
        "/lidar/scene-manifest",
        params={"copc": copc_path, "buildings": buildings_path, "profile": "balanced"},
    )

    assert response.status_code == 200
    assert response.json()["schemaVersion"] == 1
    assert response.json()["buildingCount"] == 1


def test_render_modes_have_unique_values():
    html = LIDAR_HTML.read_text(encoding="utf-8")
    options = re.findall(r'<option value="([^"]+)"', html)

    assert options[0] == "simulation"
    assert len(options) == len(set(options))
    assert {"simulation", "classification", "elevation", "intensity", "color"}.issubset(options)


def test_simulation_scene_uses_artifact_loader_registry():
    source = SIMULATION_SOURCE.read_text(encoding="utf-8")
    bootstrap = BOOTSTRAP_SOURCE.read_text(encoding="utf-8")

    assert "registerSceneArtifactLoader('copc'" in source
    assert "registerSceneArtifactLoader('itowns-layer'" in source
    assert "registerSceneArtifactLoader('box-mesh-json'" in source
    assert "visibleArtifacts" in source
    assert "window.__SIM_SCENE__" in source
    assert "await import('./simulation-mode')" in bootstrap
    assert "lidar-volumes" not in bootstrap


def test_lidar_sidebar_is_height_limited_and_scrollable():
    css = VIEWER_CSS.read_text(encoding="utf-8")

    assert "max-height: calc(100dvh - 28px)" in css
    assert "#lidar-controls-body" in css
    assert "overflow-y: auto" in css
