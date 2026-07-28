import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

GEOCODING_SEARCH_URL = "https://data.geopf.fr/geocodage/search"

app = FastAPI(title="Simulateur LiDAR France API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/geocode/search")
def geocode_search(
    q: str = Query(min_length=2, max_length=200),
    limit: int = Query(default=5, ge=1, le=10),
) -> dict:
    """Proxy local vers le géocodage Géoplateforme.

    Le navigateur interroge notre API locale, puis le serveur appelle l'API IGN.
    Cela centralise les futures stratégies de cache et évite de dépendre du CORS côté navigateur.
    """
    params = urlencode(
        {
            "q": q.strip(),
            "index": "address",
            "limit": limit,
            "autocomplete": 1,
        }
    )
    request = Request(
        f"{GEOCODING_SEARCH_URL}?{params}",
        headers={
            "Accept": "application/json",
            "Accept-Language": "fr",
            "User-Agent": "simulateur-lidar-france/0.2",
        },
    )

    try:
        with urlopen(request, timeout=8) as response:
            payload = response.read().decode("utf-8")
    except HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Géocodage indisponible : HTTP {exc.code}") from exc
    except URLError as exc:
        raise HTTPException(status_code=502, detail="Géocodage indisponible") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Géocodage trop lent") from exc

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Réponse de géocodage invalide") from exc

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Réponse de géocodage inattendue")
    return data


@app.get("/files/{relative_path:path}")
def get_file(relative_path: str) -> FileResponse:
    requested = (DATA_DIR / relative_path).resolve()
    if DATA_DIR.resolve() not in requested.parents or not requested.is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return FileResponse(requested)
