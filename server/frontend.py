from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
WEB_DIST = ROOT / "web" / "dist"


def mount_frontend(app: FastAPI, directory: Path = WEB_DIST) -> bool:
    """Monte le build Vite après les routes API, s'il est disponible."""
    if not directory.is_dir() or not directory.joinpath("index.html").is_file():
        return False

    app.mount(
        "/",
        StaticFiles(directory=str(directory), html=True),
        name="web",
    )
    return True
