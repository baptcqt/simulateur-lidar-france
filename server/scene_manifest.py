from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SCENE_SCHEMA_VERSION = 1

router = APIRouter(prefix="/lidar", tags=["scene-manifest"])


def resolve_data_path(api_path: str) -> Path:
    if not api_path.startswith("/files/"):
        raise HTTPException(status_code=400, detail="Le manifeste nécessite un fichier local servi par /files/")
    relative = api_path.removeprefix("/files/").replace("\\", "/")
    requested = (DATA_DIR / relative).resolve()
    data_root = DATA_DIR.resolve()
    if requested == data_root or data_root not in requested.parents:
        raise HTTPException(status_code=400, detail="Chemin de scène invalide")
    return requested


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Manifeste de traitement illisible : {path.name}") from exc
    return payload if isinstance(payload, dict) else {}


def building_count(payload: dict[str, Any], buildings_path: Path | None) -> int:
    value = payload.get("buildingCount")
    if isinstance(value, int) and value >= 0:
        return value
    buildings = payload.get("buildings")
    if isinstance(buildings, list):
        return len(buildings)
    if buildings_path and buildings_path.is_file():
        content = read_json(buildings_path).get("buildings")
        if isinstance(content, list):
            return len(content)
    return 0


def profile_point_budget(profile: str) -> int:
    return {
        "fluid": 750_000,
        "balanced": 1_800_000,
        "detailed": 3_500_000,
    }.get(profile, 1_800_000)


def scene_manifest_from_legacy(
    legacy: dict[str, Any],
    *,
    copc_path: str,
    buildings_path: str | None,
    profile: str,
) -> dict[str, Any]:
    point_url = legacy.get("path") if isinstance(legacy.get("path"), str) else copc_path
    declared_buildings = legacy.get("buildingsPath") if isinstance(legacy.get("buildingsPath"), str) else buildings_path
    building_file = resolve_data_path(declared_buildings) if declared_buildings else None
    count = building_count(legacy, building_file)
    point_budget = legacy.get("pointBudgetHint")
    if not isinstance(point_budget, int) or point_budget <= 0:
        point_budget = profile_point_budget(profile)

    artifacts: list[dict[str, Any]] = [
        {
            "id": "points.cleaned",
            "type": "copc",
            "role": "processed-points",
            "label": "Points traités PDAL",
            "url": point_url,
            "producer": "pdal",
            "defaultVisible": True,
            "metadata": {"pointBudgetHint": point_budget},
        },
        {
            "id": "terrain.ign",
            "type": "itowns-layer",
            "role": "terrain",
            "label": "Relief MNT IGN",
            "layerId": "IGN_MNT_HIGHRES",
            "producer": "ign",
            "defaultVisible": True,
        },
    ]
    visible = ["points.cleaned", "terrain.ign"]
    produced = ["points.cleaned"]

    if declared_buildings:
        artifacts.append(
            {
                "id": "buildings.pdal",
                "type": "box-mesh-json",
                "role": "buildings",
                "label": "Volumes bâtiment PDAL",
                "url": declared_buildings,
                "producer": "pdal",
                "defaultVisible": count > 0,
                "count": count,
                "metadata": {"source": legacy.get("buildingSource", "lidar-classification-6")},
            }
        )
        produced.append("buildings.pdal")
        if count > 0:
            visible.append("buildings.pdal")

    return {
        "schemaVersion": SCENE_SCHEMA_VERSION,
        "selection": {
            "bbox": legacy.get("bbox", {}),
            "crs": "EPSG:2154",
        },
        "runs": [
            {
                "id": "pdal",
                "status": "completed",
                "version": "local",
                "artifacts": produced,
                "metrics": {
                    "buildingCount": count,
                    "profile": profile,
                },
            }
        ],
        "artifacts": artifacts,
        "presets": {
            "simulation": {
                "visibleArtifacts": visible,
                "pointMode": "classification",
                "pointOpacity": 0.48,
                "pointSize": 1.25,
                "pointBudget": point_budget,
            }
        },
        "profile": profile,
        "pointBudgetHint": point_budget,
        "path": point_url,
        "buildingsPath": declared_buildings,
        "buildingCount": count,
    }


def scene_manifest_for(
    *,
    copc_path: str,
    buildings_path: str | None = None,
    profile: str = "balanced",
) -> dict[str, Any]:
    copc_file = resolve_data_path(copc_path)
    if not copc_file.is_file():
        raise HTTPException(status_code=404, detail="COPC traité introuvable")

    persisted_path = copc_file.with_name("manifest.json")
    persisted = read_json(persisted_path)
    if persisted.get("schemaVersion") == SCENE_SCHEMA_VERSION and isinstance(persisted.get("artifacts"), list):
        return persisted

    manifest = scene_manifest_from_legacy(
        persisted,
        copc_path=copc_path,
        buildings_path=buildings_path,
        profile=profile,
    )
    manifest["manifestPath"] = "/lidar/scene-manifest?" + urlencode(
        {
            "copc": copc_path,
            "profile": profile,
            **({"buildings": buildings_path} if buildings_path else {}),
        }
    )
    return manifest


@router.get("/scene-manifest")
def get_scene_manifest(
    copc: str = Query(description="Chemin /files/ du COPC traité"),
    buildings: str | None = Query(default=None, description="Chemin /files/ des volumes bâtiment"),
    profile: str = Query(default="balanced", pattern="^(fluid|balanced|detailed)$"),
) -> dict[str, Any]:
    return scene_manifest_for(copc_path=copc, buildings_path=buildings, profile=profile)
