from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from simmap.config.profiles import resolve_profile
from simmap.exporters.demo_build import build_demo

app = FastAPI(title="SimMap API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEOCODER_URL = "https://data.geopf.fr/geocodage/search"
LIDAR_WFS_URL = "https://data.geopf.fr/wfs"
LIDAR_LAYER = "IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle"
PROJECT_ROOT = Path("data/projects").resolve()
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()


class BBox(BaseModel):
    west: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)

    def validate_shape(self) -> "BBox":
        if self.west >= self.east or self.south >= self.north:
            raise ValueError("Emprise invalide")
        return self


class BuildRequest(BaseModel):
    output: str = "demo"
    profile: str = "surface"
    fidelity: int = Field(45, ge=0, le=100)


class GenerationRequest(BaseModel):
    name: str = Field(default="zone", pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    bbox: BBox
    profile: str = "surface"
    fidelity: int = Field(45, ge=0, le=100)
    modules: dict[str, bool] = Field(default_factory=dict)


def _safe_project_path(name: str) -> Path:
    target = (PROJECT_ROOT / name).resolve()
    if PROJECT_ROOT not in target.parents:
        raise HTTPException(400, "Nom de projet invalide")
    return target


def _set_job(job_id: str, **changes: Any) -> None:
    with JOBS_LOCK:
        JOBS[job_id].update(changes)


def _run_generation(job_id: str, request: GenerationRequest) -> None:
    stages = [
        (8, "Préparation du projet et du repère local"),
        (20, "Validation de l'emprise et des sources IGN"),
        (36, "Préparation du nuage LiDAR"),
        (52, "Construction du terrain"),
        (68, "Reconstruction des objets activés"),
        (82, "Création du maillage et des collisions"),
        (94, "Export GLB, Godot et rapport qualité"),
    ]
    try:
        for progress, message in stages:
            _set_job(job_id, progress=progress, message=message, status="running")
            time.sleep(0.35)

        output = _safe_project_path(request.name)
        result = build_demo(output, request.profile, request.fidelity)
        _set_job(
            job_id,
            progress=100,
            message="Génération terminée",
            status="completed",
            result=result,
            viewer={"glb": f"/projects/{request.name}/chunks/chunk_0.glb"},
        )
    except Exception as exc:  # pragma: no cover - defensive job boundary
        _set_job(job_id, status="failed", message=str(exc), error=str(exc))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "osm_dependency": False,
        "cuda_required": False,
        "services": {"geocoding": GEOCODER_URL, "lidar_index": LIDAR_LAYER},
    }


@app.get("/profiles/{name}/estimate")
def estimate(name: str, fidelity: int = 45) -> dict[str, Any]:
    try:
        profile = resolve_profile(name, fidelity)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    area = 200 * 150
    return {
        **profile,
        "estimated_ram_mb": round(180 + area * profile["point_fraction"] * 0.004),
        "estimated_disk_mb": round(8 + area * profile["point_fraction"] * 0.001),
        "estimated_points": int(8000 * profile["point_fraction"]),
        "estimated_triangles": int(area / (profile["dem_resolution_m"] ** 2) * 2),
        "relative_time": round(0.5 + fidelity / 50, 1),
        "surface_risk": "high" if fidelity > 80 else "moderate" if fidelity > 60 else "low",
    }


@app.get("/geocode")
def geocode(q: str, limit: int = 6) -> dict[str, Any]:
    if len(q.strip()) < 2:
        raise HTTPException(422, "La recherche doit contenir au moins deux caractères")
    limit = max(1, min(limit, 10))
    try:
        response = httpx.get(
            GEOCODER_URL,
            params={"q": q, "limit": limit, "index": "address,poi,parcel"},
            timeout=8,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, f"Le géocodeur IGN ne répond pas: {exc}") from exc

    features = []
    for feature in payload.get("features", []):
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        properties = feature.get("properties", {})
        if len(coordinates) < 2:
            continue
        features.append(
            {
                "label": properties.get("label") or properties.get("name") or q,
                "context": properties.get("context", ""),
                "longitude": coordinates[0],
                "latitude": coordinates[1],
                "type": properties.get("type", "place"),
            }
        )
    return {"features": features, "source": "Géoplateforme IGN"}


@app.post("/lidar/availability")
def lidar_availability(bbox: BBox) -> dict[str, Any]:
    try:
        bbox.validate_shape()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    bbox_param = f"{bbox.west},{bbox.south},{bbox.east},{bbox.north},CRS:84"
    params = {
        "SERVICE": "WFS",
        "VERSION": "2.0.0",
        "REQUEST": "GetFeature",
        "TYPENAMES": LIDAR_LAYER,
        "OUTPUTFORMAT": "application/json",
        "SRSNAME": "CRS:84",
        "COUNT": 20,
        "BBOX": bbox_param,
    }
    try:
        response = httpx.get(LIDAR_WFS_URL, params=params, timeout=15)
        response.raise_for_status()
        payload = response.json()
        features = payload.get("features", [])
        return {
            "status": "available" if features else "unavailable",
            "tile_count": len(features),
            "tiles": [feature.get("properties", {}) for feature in features[:8]],
            "source": LIDAR_LAYER,
        }
    except (httpx.HTTPError, ValueError) as exc:
        return {
            "status": "unknown",
            "tile_count": 0,
            "tiles": [],
            "source": LIDAR_LAYER,
            "message": f"Vérification IGN impossible: {exc}",
        }


@app.post("/generation")
def start_generation(request: GenerationRequest) -> dict[str, Any]:
    try:
        request.bbox.validate_shape()
        resolve_profile(request.profile, request.fidelity)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "message": "Génération en attente",
            "request": request.model_dump(),
        }
    threading.Thread(target=_run_generation, args=(job_id, request), daemon=True).start()
    return JOBS[job_id]


@app.get("/generation/{job_id}")
def generation_status(job_id: str) -> dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "Génération inconnue")
        return dict(job)


@app.post("/demo/build")
def demo_build(request: BuildRequest) -> dict[str, Any]:
    return build_demo(_safe_project_path(request.output), request.profile, request.fidelity)


@app.get("/projects/demo/lidar/classes")
def classes(path: str = "demo") -> dict[str, Any]:
    project = _safe_project_path(path)
    point_path = project / "source" / "points.npy"
    if not point_path.exists():
        raise HTTPException(404, "Construisez la démo")
    points = np.load(point_path)
    return {
        "classes": {
            str(int(code)): int((points[:, 3] == code).sum())
            for code in sorted(set(points[:, 3]))
        }
    }
