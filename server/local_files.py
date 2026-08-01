from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException, Request, status

ROOT = Path(__file__).resolve().parents[1]
LIDAR_DIR = ROOT / "data" / "lidar"

router = APIRouter(prefix="/local-lidar", tags=["local-lidar"])
LOCAL_FILENAME_RE = re.compile(r"[^A-Za-z0-9_. -]")


def local_file_metadata(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "sizeBytes": stat.st_size,
        "modifiedAt": stat.st_mtime,
        "path": f"/files/lidar/{path.name}",
    }


def safe_local_filename(raw_name: str) -> str:
    decoded = unquote(raw_name).strip()
    basename = Path(decoded).name
    name = LOCAL_FILENAME_RE.sub("_", basename)
    if not name.lower().endswith(".copc.laz"):
        raise HTTPException(status_code=400, detail="Sélectionnez un fichier .copc.laz")
    if not name or name in {".copc.laz", "..copc.laz"}:
        raise HTTPException(status_code=400, detail="Nom de fichier LiDAR invalide")
    return name


def open_lidar_folder() -> None:
    if os.name != "nt":
        raise RuntimeError("L’ouverture du dossier est disponible sous Windows")
    os.startfile(str(LIDAR_DIR))  # type: ignore[attr-defined]


@router.get("/files")
def list_local_lidar_files() -> dict[str, list[dict[str, Any]]]:
    files = [path for path in LIDAR_DIR.glob("*.copc.laz") if path.is_file()]
    files.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return {"files": [local_file_metadata(path) for path in files]}


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_local_lidar_file(
    request: Request,
    filename_header: str = Header(alias="X-Filename"),
) -> dict[str, Any]:
    filename = safe_local_filename(filename_header)
    LIDAR_DIR.mkdir(parents=True, exist_ok=True)
    target = LIDAR_DIR / filename
    partial = LIDAR_DIR / f".{filename}.{uuid.uuid4().hex}.part"
    written = 0

    try:
        with partial.open("wb") as output:
            async for chunk in request.stream():
                if not chunk:
                    continue
                output.write(chunk)
                written += len(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="Le fichier sélectionné est vide")
        partial.replace(target)
    except HTTPException:
        partial.unlink(missing_ok=True)
        raise
    except OSError as exc:
        partial.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Copie du fichier impossible : {exc}") from exc

    return local_file_metadata(target)


@router.post("/open-folder", status_code=status.HTTP_202_ACCEPTED)
def open_local_lidar_folder() -> dict[str, str]:
    try:
        LIDAR_DIR.mkdir(parents=True, exist_ok=True)
        open_lidar_folder()
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Impossible d’ouvrir le dossier : {exc}") from exc
    return {"status": "opened", "folder": str(LIDAR_DIR)}
