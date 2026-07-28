from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Simulateur LiDAR France API", version="0.1.0")
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


@app.get("/files/{relative_path:path}")
def get_file(relative_path: str) -> FileResponse:
    requested = (DATA_DIR / relative_path).resolve()
    if DATA_DIR.resolve() not in requested.parents or not requested.is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return FileResponse(requested)
