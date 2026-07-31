from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT / "logs"
RUNTIME_DIR = ROOT / ".runtime"
LOG_FILE = LOG_DIR / "simulateur.log"
REQUEST_LOG_FILE = LOG_DIR / "requests.log"
PDAL_LOG_FILE = LOG_DIR / "pdal.log"
FRONTEND_LOG_FILE = LOG_DIR / "frontend.log"
DIAGNOSTIC_ZIP = LOG_DIR / "diagnostic.zip"
INSTALL_FLAG = "_simulateur_observability_installed"


def ensure_log_dir() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def append_log(name: str, message: str, **extra: Any) -> None:
    ensure_log_dir()
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "name": name,
        "message": message,
        **extra,
    }
    line = json.dumps(payload, ensure_ascii=False, default=str)
    LOG_FILE.open("a", encoding="utf-8").write(line + "\n")


def _build_logger(name: str, path: Path) -> logging.Logger:
    ensure_log_dir()
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not any(isinstance(handler, logging.FileHandler) and Path(handler.baseFilename) == path for handler in logger.handlers):
        handler = logging.FileHandler(path, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        logger.addHandler(handler)
    return logger


app_logger = _build_logger("simulateur", LOG_FILE)
request_logger = _build_logger("simulateur.requests", REQUEST_LOG_FILE)
pdal_logger = _build_logger("simulateur.pdal", PDAL_LOG_FILE)
frontend_logger = _build_logger("simulateur.frontend", FRONTEND_LOG_FILE)


def pdal_candidates() -> list[dict[str, Any]]:
    candidates: list[Path] = []
    env_exe = os.environ.get("SIMULATEUR_PDAL_EXE")
    if env_exe:
        candidates.append(Path(env_exe))
    candidates.extend([
        ROOT / ".pdal-env" / "Library" / "bin" / "pdal.exe",
        ROOT / ".pdal-env" / "Scripts" / "pdal.exe",
    ])
    which = shutil.which("pdal")
    if which:
        candidates.append(Path(which))

    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved).lower()
        if key in seen:
            continue
        seen.add(key)
        result.append({
            "path": str(resolved),
            "exists": resolved.is_file(),
        })
    return result


def pdal_executable_path() -> str | None:
    for candidate in pdal_candidates():
        if candidate["exists"]:
            return candidate["path"]
    return None


def environment_snapshot() -> dict[str, Any]:
    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    return {
        "root": str(ROOT),
        "cwd": str(Path.cwd()),
        "python": sys.executable,
        "pythonVersion": sys.version,
        "platform": platform.platform(),
        "simulatorPdalExe": os.environ.get("SIMULATEUR_PDAL_EXE"),
        "pdalExecutable": pdal_executable_path(),
        "pdalCandidates": pdal_candidates(),
        "pathHasPdalEnvBin": str(ROOT / ".pdal-env" / "Library" / "bin") in path_entries,
        "pathEntriesSample": path_entries[:12],
        "logDir": str(LOG_DIR),
        "runtimeDir": str(RUNTIME_DIR),
    }


def build_diagnostics_zip() -> Path:
    ensure_log_dir()
    with zipfile.ZipFile(DIAGNOSTIC_ZIP, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in LOG_DIR.glob("*.log"):
            archive.write(path, arcname=f"logs/{path.name}")
        for path in LOG_DIR.glob("*.json"):
            archive.write(path, arcname=f"logs/{path.name}")
        for path in RUNTIME_DIR.glob("*.ps1"):
            archive.write(path, arcname=f"runtime/{path.name}")
        archive.writestr("diagnostics/status.json", json.dumps(environment_snapshot(), indent=2, ensure_ascii=False))
    return DIAGNOSTIC_ZIP


def diagnostics_zip_response() -> FileResponse:
    path = build_diagnostics_zip()
    return FileResponse(path, media_type="application/zip", filename="simulateur-diagnostic.zip")


def install_observability(app: FastAPI) -> None:
    if getattr(app.state, INSTALL_FLAG, False):
        return
    setattr(app.state, INSTALL_FLAG, True)

    ensure_log_dir()
    append_log("startup", "Installation de l'observabilité", environment=environment_snapshot())

    @app.middleware("http")
    async def log_requests(request: Request, call_next: Callable[..., Any]):  # type: ignore[no-untyped-def]
        started = time.perf_counter()
        response = None
        error: str | None = None
        try:
            response = await call_next(request)
            return response
        except Exception as exc:  # noqa: BLE001
            error = repr(exc)
            append_log("http.error", "Exception non gérée pendant une requête", method=request.method, path=request.url.path, error=error)
            raise
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            status_code = getattr(response, "status_code", 500 if error else None)
            entry = {
                "method": request.method,
                "path": request.url.path,
                "query": str(request.url.query),
                "status": status_code,
                "durationMs": duration_ms,
                "client": request.client.host if request.client else None,
                "error": error,
            }
            request_logger.info(json.dumps(entry, ensure_ascii=False))

    @app.get("/diagnostics/status")
    def diagnostics_status() -> dict[str, Any]:
        snapshot = environment_snapshot()
        append_log("diagnostics.status", "Lecture du statut diagnostic", **snapshot)
        return snapshot

    @app.post("/diagnostics/frontend")
    async def diagnostics_frontend(request: Request) -> dict[str, str]:
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {"raw": await request.body()}
        frontend_logger.info(json.dumps(payload, ensure_ascii=False, default=str))
        return {"status": "ok"}

    @app.get("/diagnostics/logs.zip")
    def diagnostics_logs_zip():
        return diagnostics_zip_response()

    @app.get("/logs.zip")
    def logs_zip_shortcut():
        return diagnostics_zip_response()


def log_pdal_event(message: str, **extra: Any) -> None:
    payload = {"message": message, **extra}
    pdal_logger.info(json.dumps(payload, ensure_ascii=False, default=str))
    append_log("pdal", message, **extra)
