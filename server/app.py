import json
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen, urlretrieve

from fastapi import FastAPI, Header, HTTPException, Query
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

app = FastAPI(title="Simulateur LiDAR France API", version="0.3.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*", "Range"],
    expose_headers=["Accept-Ranges", "Content-Length", "Content-Range"],
)


class LidarDownloadRequest(BaseModel):
    url: HttpUrl


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def fetch_json(url: str, timeout: int = 12) -> dict:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "Accept-Language": "fr",
            "User-Agent": "simulateur-lidar-france/0.3",
        },
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
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
    raw = url.rstrip("/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", raw)
    if not name.lower().endswith(".laz"):
        raise HTTPException(status_code=400, detail="URL LiDAR invalide")
    return name


def iter_file_range(path: Path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = handle.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def range_response(path: Path, range_header: str | None):
    size = path.stat().st_size
    common_headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
    }

    if not range_header:
        return FileResponse(path, media_type="application/octet-stream", headers=common_headers)

    match = RANGE_RE.fullmatch(range_header.strip())
    if not match:
        raise HTTPException(status_code=416, detail="Range invalide", headers={"Content-Range": f"bytes */{size}"})

    start_raw, end_raw = match.groups()
    if start_raw == "" and end_raw == "":
        raise HTTPException(status_code=416, detail="Range vide", headers={"Content-Range": f"bytes */{size}"})

    if start_raw == "":
        suffix_length = int(end_raw)
        start = max(size - suffix_length, 0)
        end = size - 1
    else:
        start = int(start_raw)
        end = int(end_raw) if end_raw else size - 1

    if start >= size or end < start:
        raise HTTPException(status_code=416, detail="Range hors fichier", headers={"Content-Range": f"bytes */{size}"})

    end = min(end, size - 1)
    length = end - start + 1
    headers = {
        **common_headers,
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(length),
    }
    return StreamingResponse(
        iter_file_range(path, start, end),
        status_code=206,
        media_type="application/octet-stream",
        headers=headers,
    )


@app.get("/geocode/search")
def geocode_search(
    q: str = Query(min_length=2, max_length=200),
    limit: int = Query(default=5, ge=1, le=10),
) -> dict:
    """Proxy local vers le géocodage Géoplateforme."""
    params = urlencode(
        {
            "q": q.strip(),
            "index": "address",
            "limit": limit,
            "autocomplete": 1,
        }
    )
    return fetch_json(f"{GEOCODING_SEARCH_URL}?{params}", timeout=8)


@app.get("/lidar/tiles")
def lidar_tiles(
    bbox: str = Query(description="Emprise en EPSG:4326 : minLon,minLat,maxLon,maxLat"),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict:
    """Recherche les dalles LiDAR HD IGN qui intersectent une emprise."""
    try:
        min_lon, min_lat, max_lon, max_lat = [float(part) for part in bbox.split(",")]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="bbox invalide") from exc

    if min_lon > max_lon:
        min_lon, max_lon = max_lon, min_lon
    if min_lat > max_lat:
        min_lat, max_lat = max_lat, min_lat

    params = urlencode(
        {
            "SERVICE": "WFS",
            "REQUEST": "GetFeature",
            "VERSION": "2.0.0",
            "TYPENAMES": LIDAR_TILE_TYPENAME,
            "SRSNAME": "EPSG:4326",
            "BBOX": f"{min_lon},{min_lat},{max_lon},{max_lat},EPSG:4326",
            "OUTPUTFORMAT": "application/json",
            "COUNT": limit,
        }
    )
    data = fetch_json(f"{LIDAR_WFS_URL}?{params}", timeout=20)

    features = data.get("features") if isinstance(data, dict) else None
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


@app.post("/lidar/download")
def lidar_download(payload: LidarDownloadRequest) -> dict[str, str | int]:
    """Télécharge une dalle LiDAR dans data/lidar puis renvoie son URL locale."""
    url = str(payload.url)
    if not url.startswith(LIDAR_DOWNLOAD_PREFIX):
        raise HTTPException(status_code=400, detail="Seules les URL de téléchargement Géoplateforme sont autorisées")
    if not is_copc_url(url):
        raise HTTPException(status_code=400, detail="Cette route charge uniquement les dalles COPC")

    filename = safe_filename_from_url(url)
    target = LIDAR_DIR / filename
    status = "cached"
    if not target.exists():
        status = "downloaded"
        try:
            urlretrieve(url, target)
        except Exception as exc:  # noqa: BLE001 - on remonte une erreur HTTP lisible côté interface
            if target.exists():
                target.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail=f"Téléchargement impossible : {exc}") from exc

    return {"filename": filename, "path": f"/files/lidar/{filename}", "sizeBytes": target.stat().st_size, "status": status}


@app.get("/lidar/files")
def lidar_files() -> dict[str, list[str]]:
    return {"files": sorted(path.name for path in LIDAR_DIR.glob("*.laz"))}


@app.get("/files/{relative_path:path}")
def get_file(relative_path: str, range: str | None = Header(default=None)):
    requested = (DATA_DIR / relative_path).resolve()
    if DATA_DIR.resolve() not in requested.parents or not requested.is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return range_response(requested, range)
