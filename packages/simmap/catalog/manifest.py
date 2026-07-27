from __future__ import annotations
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, platform

def sha256(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def write_manifest(project: Path, params: dict, sources: list[dict]) -> dict:
    files=[]
    for p in sorted(project.rglob('*')):
        if p.is_file() and p.name != 'manifest.json':
            files.append({"path":str(p.relative_to(project)).replace('\\','/'),"size":p.stat().st_size,"sha256":sha256(p)})
    years=[s.get('acquisition_year') for s in sources if s.get('acquisition_year')]
    warnings=[]
    if years and max(years)-min(years)>2: warnings.append("Écart de millésime supérieur à deux ans")
    doc={"schema":"simmap-manifest-1","created_at":datetime.now(timezone.utc).isoformat(),"crs_horizontal":"EPSG:2154","vertical_reference":"altitude locale synthétique pour la démo","origin_local":[0,0,0],"parameters":params,"sources":sources,"temporal_warnings":warnings,"software":{"simmap":"0.1.0","python":platform.python_version()},"files":files,"safety":"Entraînement et préparation uniquement; aucune garantie d'actualité ou de sécurité de vol."}
    (project/'manifest.json').write_text(json.dumps(doc,indent=2,ensure_ascii=False),encoding='utf-8'); return doc
