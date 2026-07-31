from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from server.observability import environment_snapshot, log_pdal_event, pdal_executable_path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
LIDAR_DIR = DATA_DIR / "lidar"
PROCESSED_DIR = DATA_DIR / "processed"
PROCESS_TIMEOUT_SECONDS = 8 * 60
BUILDING_CSV_LIMIT_BYTES = 250 * 1024 * 1024

router = APIRouter(prefix="/lidar", tags=["lidar-processing"])
PROCESS_JOBS: dict[str, dict[str, Any]] = {}
PROCESS_LOCK = threading.Lock()


class BBox4326(BaseModel):
    minLon: float
    minLat: float
    maxLon: float
    maxLat: float

    @field_validator("minLon", "maxLon")
    @classmethod
    def validate_lon(cls, value: float) -> float:
        if not math.isfinite(value) or value < -180 or value > 180:
            raise ValueError("longitude invalide")
        return value

    @field_validator("minLat", "maxLat")
    @classmethod
    def validate_lat(cls, value: float) -> float:
        if not math.isfinite(value) or value < -90 or value > 90:
            raise ValueError("latitude invalide")
        return value

    def normalized(self) -> "BBox4326":
        return BBox4326(
            minLon=min(self.minLon, self.maxLon),
            minLat=min(self.minLat, self.maxLat),
            maxLon=max(self.minLon, self.maxLon),
            maxLat=max(self.minLat, self.maxLat),
        )


ProcessProfile = Literal["fluid", "balanced", "detailed"]


class ProcessRequest(BaseModel):
    path: str = Field(description="Chemin local renvoyé par l’API, par exemple /files/lidar/dalle.copc.laz")
    bbox: BBox4326
    profile: ProcessProfile = "balanced"


@dataclass(frozen=True)
class ProfileConfig:
    decimation_step: int
    building_decimation_step: int
    building_cell_size: float
    min_building_points: int
    max_building_boxes: int
    point_budget_hint: int


PROFILES: dict[ProcessProfile, ProfileConfig] = {
    "fluid": ProfileConfig(
        decimation_step=12,
        building_decimation_step=8,
        building_cell_size=10.0,
        min_building_points=18,
        max_building_boxes=120,
        point_budget_hint=750_000,
    ),
    "balanced": ProfileConfig(
        decimation_step=5,
        building_decimation_step=4,
        building_cell_size=7.0,
        min_building_points=24,
        max_building_boxes=260,
        point_budget_hint=1_800_000,
    ),
    "detailed": ProfileConfig(
        decimation_step=2,
        building_decimation_step=2,
        building_cell_size=5.0,
        min_building_points=32,
        max_building_boxes=500,
        point_budget_hint=3_500_000,
    ),
}

SIMULATION_CLASS_EXPRESSION = "Classification == 1 || Classification == 2 || Classification == 3 || Classification == 4 || Classification == 5 || Classification == 6 || Classification == 9 || Classification == 17"
BUILDING_SOURCE_EXPRESSION = "Classification == 2 || Classification == 6"


def pdal_executable() -> str | None:
    env_exe = os.environ.get("SIMULATEUR_PDAL_EXE")
    candidates = [
        Path(env_exe) if env_exe else None,
        ROOT / ".pdal-env" / "Library" / "bin" / "pdal.exe",
        ROOT / ".pdal-env" / "Scripts" / "pdal.exe",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return str(candidate.resolve())
    return pdal_executable_path() or shutil.which("pdal")


def resolve_local_lidar_path(api_path: str) -> Path:
    if not api_path.startswith("/files/"):
        raise HTTPException(status_code=400, detail="Le traitement PDAL nécessite un fichier local")
    relative = api_path.removeprefix("/files/").replace("\\", "/")
    requested = (DATA_DIR / relative).resolve()
    data_root = DATA_DIR.resolve()
    if requested == data_root or data_root not in requested.parents or not requested.is_file():
        raise HTTPException(status_code=404, detail="Fichier LiDAR local introuvable")
    if not requested.name.lower().endswith(".copc.laz"):
        raise HTTPException(status_code=400, detail="Seuls les fichiers .copc.laz sont traités")
    return requested


def output_directory(source: Path, request: ProcessRequest) -> Path:
    bbox = request.bbox.normalized()
    stat = source.stat()
    fingerprint = json.dumps(
        {
            "source": str(source.relative_to(DATA_DIR.resolve())),
            "mtime": stat.st_mtime_ns,
            "size": stat.st_size,
            "bbox": bbox.model_dump(),
            "profile": request.profile,
            "version": 3,
        },
        sort_keys=True,
    ).encode("utf-8")
    digest = hashlib.sha256(fingerprint).hexdigest()[:20]
    return PROCESSED_DIR / digest


def bounds_expression(bbox: BBox4326) -> str:
    value = bbox.normalized()
    return f"([{value.minLon:.12f},{value.maxLon:.12f}],[{value.minLat:.12f},{value.maxLat:.12f}])"


def common_crop_stages(source: Path, bbox: BBox4326) -> list[dict[str, Any]]:
    return [
        {"type": "readers.copc", "filename": str(source)},
        {"type": "filters.reprojection", "out_srs": "EPSG:4326"},
        {"type": "filters.crop", "bounds": bounds_expression(bbox)},
        {"type": "filters.reprojection", "out_srs": "EPSG:2154"},
    ]


def processed_copc_pipeline(source: Path, target: Path, request: ProcessRequest) -> dict[str, Any]:
    config = PROFILES[request.profile]
    stages = common_crop_stages(source, request.bbox)
    stages.append({"type": "filters.expression", "expression": SIMULATION_CLASS_EXPRESSION})
    if config.decimation_step > 1:
        stages.append({"type": "filters.decimation", "step": config.decimation_step})
    stages.append({
        "type": "writers.copc",
        "filename": str(target),
        "forward": "all",
        "a_srs": "EPSG:2154",
    })
    return {"pipeline": stages}


def building_points_pipeline(source: Path, target: Path, request: ProcessRequest) -> dict[str, Any]:
    config = PROFILES[request.profile]
    stages = common_crop_stages(source, request.bbox)
    stages.append({"type": "filters.expression", "expression": BUILDING_SOURCE_EXPRESSION})
    if config.building_decimation_step > 1:
        stages.append({"type": "filters.decimation", "step": config.building_decimation_step})
    stages.append({
        "type": "writers.text",
        "filename": str(target),
        "order": "X,Y,Z,Classification",
        "keep_unspecified": False,
    })
    return {"pipeline": stages}


def write_pipeline(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run_pdal_pipeline(pipeline_path: Path, *, timeout: int = PROCESS_TIMEOUT_SECONDS) -> None:
    executable = pdal_executable()
    log_pdal_event("Préparation pipeline", executable=executable, pipeline=str(pipeline_path), cwd=str(ROOT))
    if not executable:
        snapshot = environment_snapshot()
        log_pdal_event("PDAL introuvable", pipeline=str(pipeline_path), environment=snapshot)
        raise RuntimeError("PDAL est introuvable. Installez PDAL puis relancez le simulateur.")
    result = subprocess.run(
        [executable, "pipeline", str(pipeline_path)],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    log_pdal_event(
        "Fin pipeline",
        executable=executable,
        pipeline=str(pipeline_path),
        returncode=result.returncode,
        stdout=(result.stdout or "")[-4000:],
        stderr=(result.stderr or "")[-4000:],
    )
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "erreur PDAL inconnue").strip()
        raise RuntimeError(f"PDAL a échoué : {details[-1200:]}")


def _cell_key(x: float, y: float, size: float) -> tuple[int, int]:
    return math.floor(x / size), math.floor(y / size)


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        raise ValueError("liste vide")
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * ratio)))
    return ordered[index]


def _update_bounds(bounds: dict[str, float], x: float, y: float, z: float) -> None:
    bounds["minX"] = min(bounds["minX"], x)
    bounds["maxX"] = max(bounds["maxX"], x)
    bounds["minY"] = min(bounds["minY"], y)
    bounds["maxY"] = max(bounds["maxY"], y)
    bounds["minZ"] = min(bounds["minZ"], z)
    bounds["maxZ"] = max(bounds["maxZ"], z)


def generate_lidar_building_boxes(csv_path: Path, profile: ProcessProfile) -> list[dict[str, Any]]:
    if not csv_path.exists() or csv_path.stat().st_size == 0:
        return []
    if csv_path.stat().st_size > BUILDING_CSV_LIMIT_BYTES:
        raise RuntimeError("Le fichier intermédiaire bâtiment est trop volumineux. Utilisez le profil Fluide ou une zone plus petite.")

    config = PROFILES[profile]
    building_cells: dict[tuple[int, int], dict[str, Any]] = {}
    ground_cells: dict[tuple[int, int], list[float]] = {}

    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            try:
                x = float(row["X"])
                y = float(row["Y"])
                z = float(row["Z"])
                classification = int(float(row["Classification"]))
            except (KeyError, TypeError, ValueError):
                continue
            key = _cell_key(x, y, config.building_cell_size)
            if classification == 2:
                ground_cells.setdefault(key, []).append(z)
            elif classification == 6:
                cell = building_cells.setdefault(key, {
                    "points": 0,
                    "minX": math.inf,
                    "maxX": -math.inf,
                    "minY": math.inf,
                    "maxY": -math.inf,
                    "minZ": math.inf,
                    "maxZ": -math.inf,
                    "roofSamples": [],
                })
                cell["points"] += 1
                cell["roofSamples"].append(z)
                _update_bounds(cell, x, y, z)

    visited: set[tuple[int, int]] = set()
    boxes: list[dict[str, Any]] = []
    neighbor_offsets = [(1, 0), (-1, 0), (0, 1), (0, -1)]

    for start in list(building_cells):
        if start in visited:
            continue
        stack = [start]
        visited.add(start)
        component: list[tuple[int, int]] = []
        while stack:
            current = stack.pop()
            component.append(current)
            for dx, dy in neighbor_offsets:
                neighbor = (current[0] + dx, current[1] + dy)
                if neighbor in building_cells and neighbor not in visited:
                    visited.add(neighbor)
                    stack.append(neighbor)

        points = sum(int(building_cells[cell]["points"]) for cell in component)
        if points < config.min_building_points:
            continue

        bounds = {
            "minX": math.inf,
            "maxX": -math.inf,
            "minY": math.inf,
            "maxY": -math.inf,
            "minZ": math.inf,
            "maxZ": -math.inf,
        }
        roof_samples: list[float] = []
        for cell_key in component:
            cell = building_cells[cell_key]
            _update_bounds(bounds, cell["minX"], cell["minY"], cell["minZ"])
            _update_bounds(bounds, cell["maxX"], cell["maxY"], cell["maxZ"])
            roof_samples.extend(cell["roofSamples"])

        ground_samples: list[float] = []
        component_keys = set(component)
        for key in component_keys:
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    ground_samples.extend(ground_cells.get((key[0] + dx, key[1] + dy), []))

        roof_z = _percentile(roof_samples, 0.9) if roof_samples else bounds["maxZ"]
        ground_z = median(ground_samples) if ground_samples else max(bounds["minZ"] - 7.0, bounds["minZ"] - max(4.0, roof_z - bounds["minZ"]))
        height = roof_z - ground_z
        width = bounds["maxX"] - bounds["minX"]
        depth = bounds["maxY"] - bounds["minY"]
        if height < 2.5 or width < 2.0 or depth < 2.0:
            continue

        boxes.append({
            "id": f"lidar-building-{len(boxes) + 1}",
            "crs": "EPSG:2154",
            "minX": round(bounds["minX"], 3),
            "minY": round(bounds["minY"], 3),
            "minZ": round(float(ground_z), 3),
            "maxX": round(bounds["maxX"], 3),
            "maxY": round(bounds["maxY"], 3),
            "maxZ": round(float(roof_z), 3),
            "points": points,
            "cellCount": len(component),
            "source": "lidar-classification-6",
        })

    boxes.sort(key=lambda item: item["points"], reverse=True)
    return boxes[:config.max_building_boxes]


def data_url(path: Path) -> str:
    return "/files/" + path.relative_to(DATA_DIR).as_posix()


def manifest_for(output_dir: Path) -> dict[str, Any] | None:
    manifest = output_dir / "manifest.json"
    if not manifest.is_file():
        return None
    try:
        return json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _update_process_job(job_id: str, **changes: Any) -> None:
    with PROCESS_LOCK:
        job = PROCESS_JOBS.get(job_id)
        if job is not None:
            job.update(changes)
            job["updatedAt"] = time.time()


def _job_from_manifest(job_id: str, manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job_id,
        "status": "completed",
        "phase": "cached",
        "path": manifest.get("path"),
        "buildingsPath": manifest.get("buildingsPath"),
        "buildings": manifest.get("buildings", []),
        "buildingCount": manifest.get("buildingCount", 0),
        "profile": manifest.get("profile"),
        "pointBudgetHint": manifest.get("pointBudgetHint"),
        "error": None,
        "updatedAt": time.time(),
    }


def _process_worker(job_id: str, payload: ProcessRequest) -> None:
    try:
        log_pdal_event("Démarrage job", jobId=job_id, payload=payload.model_dump())
        source = resolve_local_lidar_path(payload.path)
        output_dir = output_directory(source, payload)
        output_dir.mkdir(parents=True, exist_ok=True)
        output_file = output_dir / "selection.copc.laz"
        building_csv = output_dir / "building_points.csv"
        building_json = output_dir / "buildings.json"
        manifest_file = output_dir / "manifest.json"

        existing = manifest_for(output_dir)
        if existing and output_file.is_file():
            log_pdal_event("Réutilisation cache", jobId=job_id, output=str(output_file), manifest=existing)
            _update_process_job(job_id, **_job_from_manifest(job_id, existing))
            return

        _update_process_job(job_id, status="running", phase="crop-clean", path=None)
        crop_pipeline = output_dir / "crop-clean.pipeline.json"
        write_pipeline(crop_pipeline, processed_copc_pipeline(source, output_file, payload))
        run_pdal_pipeline(crop_pipeline)

        _update_process_job(job_id, status="running", phase="building-detection")
        building_pipeline = output_dir / "building-points.pipeline.json"
        write_pipeline(building_pipeline, building_points_pipeline(source, building_csv, payload))
        run_pdal_pipeline(building_pipeline)
        buildings = generate_lidar_building_boxes(building_csv, payload.profile)
        building_json.write_text(json.dumps({"buildings": buildings}, indent=2), encoding="utf-8")

        manifest = {
            "path": data_url(output_file),
            "buildingsPath": data_url(building_json),
            "buildings": buildings,
            "buildingCount": len(buildings),
            "bbox": payload.bbox.normalized().model_dump(),
            "profile": payload.profile,
            "pointBudgetHint": PROFILES[payload.profile].point_budget_hint,
            "sourcePath": payload.path,
            "createdAt": time.time(),
            "tool": "pdal",
            "pdalExecutable": pdal_executable(),
            "buildingSource": "lidar-classification-6-only",
        }
        manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        log_pdal_event("Job terminé", jobId=job_id, output=str(output_file), buildingCount=len(buildings), manifest=manifest)
        _update_process_job(job_id, **_job_from_manifest(job_id, manifest))
    except Exception as exc:  # noqa: BLE001 - frontière asynchrone lisible côté API
        log_pdal_event("Job échoué", jobId=job_id, error=repr(exc), environment=environment_snapshot())
        _update_process_job(job_id, status="failed", phase="failed", error=str(exc))


@router.get("/pdal/status")
def pdal_status() -> dict[str, Any]:
    executable = pdal_executable()
    snapshot = environment_snapshot()
    log_pdal_event("Statut PDAL", available=bool(executable), executable=executable, environment=snapshot)
    return {
        "available": bool(executable),
        "executable": executable,
        "profiles": list(PROFILES),
        "environment": snapshot,
    }


@router.post("/processes", status_code=status.HTTP_202_ACCEPTED)
def start_lidar_process(payload: ProcessRequest) -> dict[str, Any]:
    source = resolve_local_lidar_path(payload.path)
    output_dir = output_directory(source, payload)
    existing = manifest_for(output_dir)
    job_id = uuid.uuid4().hex
    now = time.time()
    log_pdal_event("Requête traitement", jobId=job_id, source=str(source), outputDir=str(output_dir), payload=payload.model_dump())
    if existing and (output_dir / "selection.copc.laz").is_file():
        job = _job_from_manifest(job_id, existing)
        job["createdAt"] = now
        with PROCESS_LOCK:
            PROCESS_JOBS[job_id] = job
        log_pdal_event("Réponse cache immédiate", jobId=job_id, manifest=existing)
        return dict(job)

    job = {
        "id": job_id,
        "status": "queued",
        "phase": "queued",
        "path": None,
        "buildingsPath": None,
        "buildings": [],
        "buildingCount": 0,
        "profile": payload.profile,
        "pointBudgetHint": PROFILES[payload.profile].point_budget_hint,
        "error": None,
        "createdAt": now,
        "updatedAt": now,
    }
    with PROCESS_LOCK:
        PROCESS_JOBS[job_id] = job
    thread = threading.Thread(target=_process_worker, args=(job_id, payload), daemon=True)
    thread.start()
    return dict(job)


@router.get("/processes/{job_id}")
def lidar_process_status(job_id: str) -> dict[str, Any]:
    with PROCESS_LOCK:
        job = PROCESS_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Traitement LiDAR inconnu")
        return dict(job)
