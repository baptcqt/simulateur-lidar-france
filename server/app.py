from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import FastAPI, Header, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, HttpUrl

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
LIDAR_DIR = DATA_DIR / "lidar"
DATA_DIR.mkdir(exist_ok=True)
LIDAR_DIR.mkdir(parents=True, exist_ok=True)

GEOCODING_SEARCH_URL = "https://data.geopf.fr/geocodage/search"
LIDAR_WFS_URL = "https://data.geopf.fr/wfs/ows"
LIDAR_TILE_TYPENAME = "IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle"
LIDAR_DOWNLOAD_PREFIX = "https://data.geopf.fr/telechargement/download/"
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
DOWNLOAD_CHUNK_SIZE = 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 45
DOWNLOAD_JOBS: dict[str, dict[str, Any]] = {}
DOWNLOAD_CANCEL_EVENTS: dict[str, threading.Event] = {}
DOWNLOAD_LOCK = threading.Lock()

app = FastAPI(title="Simulateur LiDAR France API", version="0.5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "HEAD", "POST", "DELETE"],
    allow_headers=["*", "Range"],
    expose_headers=["Accept-Ranges", "Content-Length", "Content-Range"],
)


class LidarDownloadRequest(BaseModel):
    url: HttpUrl


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def fetch_json(url: str, timeout: int = 12) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "Accept-Language": "fr",
            "User-Agent": "simulateur-lidar-france/0.5",
        },
    )
    try:
        with urlopen(request, timeout=timeout) as remote_response:
            payload = remote_response.read().decode("utf-8")
    except HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Service distant indisponible : HTTP {exc.code}") from exc
    except URLError as exc:
        raise HTTPException(status_code=502, detail="Service distant indisponible") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Service distant trop lent") from exc

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Réponse distante invalide") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Réponse distante inattendue")
    return data


def is_laz_url(value: str) -> bool:
    return bool(re.search(r"^https?://.*\.laz(?:[?#].*)?$", value, re.IGNORECASE))


def is_copc_url(value: str) -> bool:
    return ".copc.laz" in value.lower()


def find_download_url(value: object) -> str | None:
    """Trouve une URL LAZ/COPC dans une réponse WFS, en préférant COPC."""
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed if is_laz_url(trimmed) else None

    candidates: list[str] = []
    if isinstance(value, dict):
        for child in value.values():
            found = find_download_url(child)
            if found:
                candidates.append(found)
    elif isinstance(value, list):
        for child in value:
            found = find_download_url(child)
            if found:
                candidates.append(found)

    if not candidates:
        return None
    return next((url for url in candidates if is_copc_url(url)), candidates[0])


def safe_filename_from_url(url: str) -> str:
    raw = url.split("?", 1)[0].split("#", 1)[0].rstrip("/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", raw)
    if not name.lower().endswith(".laz"):
        raise HTTPException(status_code=400, detail="URL LiDAR invalide")
    return name


def validate_download_url(url: str) -> None:
    if not url.startswith(LIDAR_DOWNLOAD_PREFIX):
        raise HTTPException(status_code=400, detail="Seules les URL de téléchargement Géoplateforme sont autorisées")
    if not is_copc_url(url):
        raise HTTPException(status_code=400, detail="Cette route charge uniquement les dalles COPC")


def parse_range_header(range_header: str | None, size: int) -> tuple[int, int] | None:
    if range_header is None:
        return None
    match = RANGE_RE.fullmatch(range_header.strip())
    if not match:
        raise HTTPException(status_code=416, detail="Range invalide", headers={"Content-Range": f"bytes */{size}"})

    start_raw, end_raw = match.groups()
    if not start_raw and not end_raw:
        raise HTTPException(status_code=416, detail="Range vide", headers={"Content-Range": f"bytes */{size}"})

    if not start_raw:
        suffix_length = int(end_raw)
        if suffix_length <= 0:
            raise HTTPException(status_code=416, detail="Range invalide", headers={"Content-Range": f"bytes */{size}"})
        start = max(size - suffix_length, 0)
        end = size - 1
    else:
        start = int(start_raw)
        end = int(end_raw) if end_raw else size - 1

    if start >= size or end < start:
        raise HTTPException(status_code=416, detail="Range hors fichier", headers={"Content-Range": f"bytes */{size}"})
    return start, min(end, size - 1)


def iter_file_range(path: Path, start: int, end: int, chunk_size: int = DOWNLOAD_CHUNK_SIZE) -> Iterator[bytes]:
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = handle.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def file_response(path: Path, range_header: str | None, *, head_only: bool = False):
    size = path.stat().st_size
    selected_range = parse_range_header(range_header, size)
    headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Cache-Control": "private, max-age=3600",
    }

    if selected_range is None:
        headers["Content-Length"] = str(size)
        if head_only:
            return Response(status_code=200, media_type="application/octet-stream", headers=headers)
        return FileResponse(path, media_type="application/octet-stream", headers=headers)

    start, end = selected_range
    headers.update({
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(end - start + 1),
    })
    if head_only:
        return Response(status_code=206, media_type="application/octet-stream", headers=headers)
    return StreamingResponse(
        iter_file_range(path, start, end),
        status_code=206,
        media_type="application/octet-stream",
        headers=headers,
    )


def _update_download_job(job_id: str, **changes: Any) -> None:
    with DOWNLOAD_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job is not None:
            job.update(changes)
            job["updatedAt"] = time.time()


def _download_worker(job_id: str, url: str, target: Path) -> None:
    cancel_event = DOWNLOAD_CANCEL_EVENTS[job_id]
    partial = target.with_name(f".{target.name}.{job_id}.part")
    try:
        if target.exists() and target.stat().st_size > 0:
            size = target.stat().st_size
            _update_download_job(
                job_id,
                status="completed",
                phase="cached",
                bytesDownloaded=size,
                totalBytes=size,
                filename=target.name,
                path=f"/files/lidar/{target.name}",
            )
            return

        request = Request(url, headers={"User-Agent": "simulateur-lidar-france/0.5"})
        with urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as remote_response:
            total_header = remote_response.headers.get("Content-Length")
            total = int(total_header) if total_header and total_header.isdigit() else None
            _update_download_job(job_id, status="running", phase="downloading", totalBytes=total)

            downloaded = 0
            with partial.open("wb") as output:
                while True:
                    if cancel_event.is_set():
                        raise InterruptedError("Téléchargement annulé")
                    chunk = remote_response.read(DOWNLOAD_CHUNK_SIZE)
                    if not chunk:
                        break
                    output.write(chunk)
                    downloaded += len(chunk)
                    _update_download_job(job_id, bytesDownloaded=downloaded)

        if cancel_event.is_set():
            raise InterruptedError("Téléchargement annulé")
        if partial.stat().st_size == 0:
            raise RuntimeError("Le serveur distant a renvoyé un fichier vide")
        partial.replace(target)
        size = target.stat().st_size
        _update_download_job(
            job_id,
            status="completed",
            phase="downloaded",
            bytesDownloaded=size,
            totalBytes=size,
            filename=target.name,
            path=f"/files/lidar/{target.name}",
        )
    except InterruptedError as exc:
        partial.unlink(missing_ok=True)
        _update_download_job(job_id, status="cancelled", phase="cancelled", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - frontière d'un job asynchrone
        partial.unlink(missing_ok=True)
        _update_download_job(job_id, status="failed", phase="failed", error=str(exc))


@app.get("/geocode/search")
def geocode_search(
    q: str = Query(min_length=2, max_length=200),
    limit: int = Query(default=5, ge=1, le=10),
) -> dict[str, Any]:
    params = urlencode({"q": q.strip(), "index": "address", "limit": limit, "autocomplete": 1})
    return fetch_json(f"{GEOCODING_SEARCH_URL}?{params}", timeout=8)


@app.get("/lidar/tiles")
def lidar_tiles(
    bbox: str = Query(description="Emprise en EPSG:4326 : minLon,minLat,maxLon,maxLat"),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, Any]:
    try:
        values = [float(part) for part in bbox.split(",")]
        if len(values) != 4:
            raise ValueError
        min_lon, min_lat, max_lon, max_lat = values
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="bbox invalide") from exc

    if min_lon > max_lon:
        min_lon, max_lon = max_lon, min_lon
    if min_lat > max_lat:
        min_lat, max_lat = max_lat, min_lat

    params = urlencode({
        "SERVICE": "WFS",
        "REQUEST": "GetFeature",
        "VERSION": "2.0.0",
        "TYPENAMES": LIDAR_TILE_TYPENAME,
        "SRSNAME": "EPSG:4326",
        "BBOX": f"{min_lon},{min_lat},{max_lon},{max_lat},EPSG:4326",
        "OUTPUTFORMAT": "application/json",
        "COUNT": limit,
    })
    data = fetch_json(f"{LIDAR_WFS_URL}?{params}", timeout=20)
    features = data.get("features")
    if isinstance(features, list):
        for feature in features:
            if not isinstance(feature, dict):
                continue
            properties = feature.get("properties")
            if isinstance(properties, dict):
                download_url = find_download_url(properties)
                feature["downloadUrl"] = download_url
                feature["isCopc"] = bool(download_url and is_copc_url(download_url))
    return data


@app.post("/lidar/downloads", status_code=status.HTTP_202_ACCEPTED)
def start_lidar_download(payload: LidarDownloadRequest) -> dict[str, Any]:
    url = str(payload.url)
    validate_download_url(url)
    filename = safe_filename_from_url(url)
    target = LIDAR_DIR / filename
    job_id = uuid.uuid4().hex
    now = time.time()
    job = {
        "id": job_id,
        "status": "queued",
        "phase": "queued",
        "url": url,
        "filename": filename,
        "path": None,
        "bytesDownloaded": 0,
        "totalBytes": target.stat().st_size if target.exists() else None,
        "error": None,
        "createdAt": now,
        "updatedAt": now,
    }
    with DOWNLOAD_LOCK:
        DOWNLOAD_JOBS[job_id] = job
        DOWNLOAD_CANCEL_EVENTS[job_id] = threading.Event()
    thread = threading.Thread(target=_download_worker, args=(job_id, url, target), daemon=True)
    thread.start()
    return dict(job)


@app.get("/lidar/downloads/{job_id}")
def lidar_download_status(job_id: str) -> dict[str, Any]:
    with DOWNLOAD_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Téléchargement inconnu")
        return dict(job)


@app.delete("/lidar/downloads/{job_id}", status_code=status.HTTP_202_ACCEPTED)
def cancel_lidar_download(job_id: str) -> dict[str, Any]:
    with DOWNLOAD_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        cancel_event = DOWNLOAD_CANCEL_EVENTS.get(job_id)
        if job is None or cancel_event is None:
            raise HTTPException(status_code=404, detail="Téléchargement inconnu")
        if job["status"] in {"completed", "failed", "cancelled"}:
            return dict(job)
        cancel_event.set()
        job["phase"] = "cancelling"
        job["updatedAt"] = time.time()
        return dict(job)


@app.get("/lidar/files")
def lidar_files() -> dict[str, list[dict[str, Any]]]:
    return {
        "files": [
            {"name": path.name, "sizeBytes": path.stat().st_size, "path": f"/files/lidar/{path.name}"}
            for path in sorted(LIDAR_DIR.glob("*.laz"))
        ]
    }


def resolve_data_file(relative_path: str) -> Path:
    requested = (DATA_DIR / relative_path).resolve()
    data_root = DATA_DIR.resolve()
    if requested == data_root or data_root not in requested.parents or not requested.is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return requested


@app.get("/files/{relative_path:path}")
def get_file(relative_path: str, range_header: str | None = Header(default=None, alias="Range")):
    return file_response(resolve_data_file(relative_path), range_header)


@app.head("/files/{relative_path:path}")
def head_file(relative_path: str, range_header: str | None = Header(default=None, alias="Range")):
    return file_response(resolve_data_file(relative_path), range_header, head_only=True)


# Register extension routes on the canonical application itself. This keeps
# `server.app:app` and `server.main:app` equivalent for every launcher.
from server.local_files import router as local_lidar_router  # noqa: E402
from server.pdal_processing import router as pdal_processing_router  # noqa: E402

app.include_router(local_lidar_router)
app.include_router(pdal_processing_router)
