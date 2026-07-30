from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LOCAL_PDAL_ENV = ROOT / ".pdal-env"
LOCAL_PDAL_BIN = LOCAL_PDAL_ENV / "Library" / "bin"


def _prepend_path_once(path: Path) -> None:
    if not path.exists():
        return
    value = str(path)
    entries = os.environ.get("PATH", "").split(os.pathsep)
    if value not in entries:
        os.environ["PATH"] = value + os.pathsep + os.environ.get("PATH", "")


# Python charge automatiquement sitecustomize au démarrage. Cela rend l'environnement
# PDAL installé localement visible même lorsque le serveur est lancé dans une nouvelle
# fenêtre PowerShell ou par le reloader uvicorn.
_prepend_path_once(LOCAL_PDAL_ENV / "Library" / "bin")
_prepend_path_once(LOCAL_PDAL_ENV / "Scripts")
_prepend_path_once(LOCAL_PDAL_ENV / "Library" / "usr" / "bin")

if LOCAL_PDAL_BIN.joinpath("pdal.exe").is_file():
    os.environ.setdefault("SIMULATEUR_PDAL_EXE", str(LOCAL_PDAL_BIN / "pdal.exe"))
