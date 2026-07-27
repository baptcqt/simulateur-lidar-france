from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from simmap.config.profiles import resolve_profile
from simmap.exporters.demo_build import build_demo
import numpy as np
app=FastAPI(title='SimMap API',version='0.1.0')
app.add_middleware(CORSMiddleware,allow_origins=['http://127.0.0.1:5173','http://localhost:5173'],allow_methods=['*'],allow_headers=['*'])
class BuildRequest(BaseModel):
 output:str='data/projects/demo'; profile:str='surface'; fidelity:int=Field(45,ge=0,le=100)
@app.get('/health')
def health(): return {'status':'ok','osm_dependency':False,'cuda_required':False}
@app.get('/profiles/{name}/estimate')
def estimate(name:str,fidelity:int=45):
 try:p=resolve_profile(name,fidelity)
 except ValueError as e: raise HTTPException(404,str(e))
 area=200*150; return {**p,'estimated_ram_mb':round(180+area*p['point_fraction']*.004),'estimated_disk_mb':round(8+area*p['point_fraction']*.001),'estimated_points':int(8000*p['point_fraction']),'estimated_triangles':int(area/(p['dem_resolution_m']**2)*2),'relative_time':round(.5+fidelity/50,1),'surface_risk':'high' if fidelity>80 else 'moderate' if fidelity>60 else 'low'}
@app.post('/demo/build')
def demo_build(req:BuildRequest): return build_demo(Path(req.output),req.profile,req.fidelity)
@app.get('/projects/demo/lidar/classes')
def classes(path:str='data/projects/demo'):
 p=Path(path)/'source'/'points.npy'
 if not p.exists(): raise HTTPException(404,'Construisez la démo')
 a=np.load(p); return {'classes':{str(int(c)):int((a[:,3]==c).sum()) for c in sorted(set(a[:,3]))}}
