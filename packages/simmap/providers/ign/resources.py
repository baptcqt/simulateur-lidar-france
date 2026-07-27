from pathlib import Path
import hashlib, urllib.request

def fetch(url: str, destination: Path, expected_sha256: str|None=None, max_bytes: int=2_000_000_000):
 destination.parent.mkdir(parents=True,exist_ok=True); req=urllib.request.Request(url,headers={'User-Agent':'simmap/0.1'})
 with urllib.request.urlopen(req,timeout=60) as r, destination.open('wb') as f:
  total=0
  while chunk:=r.read(1024*1024):
   total+=len(chunk)
   if total>max_bytes: raise ValueError('Taille maximale dépassée')
   f.write(chunk)
 digest=hashlib.sha256(destination.read_bytes()).hexdigest()
 if expected_sha256 and digest.lower()!=expected_sha256.lower(): destination.unlink(missing_ok=True); raise ValueError('Checksum invalide')
 return digest
