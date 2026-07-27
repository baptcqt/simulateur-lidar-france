from pathlib import Path
import json, platform, shutil, os, subprocess
import typer
from simmap.exporters.demo_build import build_demo
from simmap.quality.report import write as quality_write
from simmap.jobs.store import migrate
app=typer.Typer(help='Simulateur LiDAR France — pipeline CPU-first sans OSM')
demo=typer.Typer(); project=typer.Typer(); sources=typer.Typer(); quality=typer.Typer(); build=typer.Typer(); export=typer.Typer()
app.add_typer(demo,name='demo'); app.add_typer(project,name='project'); app.add_typer(sources,name='sources'); app.add_typer(quality,name='quality'); app.add_typer(build,name='build'); app.add_typer(export,name='export')

@app.command()
def doctor():
 import psutil
 checks={"os":platform.platform(),"cpu":platform.processor(),"memory_gb":round(psutil.virtual_memory().total/2**30,1),"disk_free_gb":round(shutil.disk_usage(Path.home()).free/2**30,1),"git":shutil.which('git'),"conda":shutil.which('conda') or shutil.which('mamba'),"node":shutil.which('node'),"godot":shutil.which('godot') or shutil.which('godot4'),"pdal":shutil.which('pdal'),"gdalinfo":shutil.which('gdalinfo'),"projinfo":shutil.which('projinfo'),"wsl":shutil.which('wsl'),"gpu_required":False}
 checks['recommended_profile']='surface' if checks['memory_gb']<16 else 'standard' if checks['memory_gb']<32 else 'quality'; typer.echo(json.dumps(checks,indent=2,ensure_ascii=False))

@demo.command('build')
def demo_build(output:Path=Path('data/projects/demo'),profile:str='surface',fidelity:int=45): typer.echo(json.dumps(build_demo(output,profile,fidelity),indent=2,ensure_ascii=False,default=str))

@project.command('create')
def project_create(name:str,address:str|None=None,radius:int=300,profile:str='surface',root:Path=Path('data/projects')):
 p=root/name; p.mkdir(parents=True,exist_ok=True); (p/'project.json').write_text(json.dumps({"name":name,"address":address,"radius_m":radius,"profile":profile,"status":"created; acquisition pending"},indent=2,ensure_ascii=False),encoding='utf-8'); migrate(root/'simmap.sqlite'); typer.echo(str(p))

@sources.command('discover')
def sources_discover(config:Path=Path('configs/ign-resources.yml')): typer.echo(config.read_text(encoding='utf-8'))
@sources.command('fetch')
def sources_fetch(dry_run:bool=True): typer.echo('Mode sécurisé: renseigner une ressource validée dans configs/ign-resources.yml. dry-run='+str(dry_run))

@quality.command('report')
def quality_report(project:Path=Path('data/projects/demo')): typer.echo(json.dumps(quality_write(project),indent=2))

@build.command('all')
def build_all(project:Path=Path('data/projects/demo'),profile:str='surface',fidelity:int=45,resume:bool=False,force:bool=False): typer.echo(json.dumps(build_demo(project,profile,fidelity),indent=2,default=str))
for n in ['terrain','buildings','roads','vegetation']:
 build.command(n)(lambda project=Path('data/projects/demo'), _n=n: typer.echo(f'{_n}: inclus dans simmap build all pour le MVP'))
for n in ['glb','godot','gazebo']:
 export.command(n)(lambda project=Path('data/projects/demo'), _n=n: typer.echo(str(project/('chunks/chunk_0.glb' if _n=='glb' else _n))))

@app.command()
def serve(host:str='127.0.0.1',port:int=8000):
 import uvicorn; uvicorn.run('apps.api.main:app',host=host,port=port,reload=False)

@app.command('inspect-lidar')
def inspect_lidar(project:Path=Path('data/projects/demo')):
 import numpy as np; p=np.load(project/'source'/'points.npy'); typer.echo(json.dumps({str(int(c)):int((p[:,3]==c).sum()) for c in sorted(set(p[:,3]))},indent=2))

if __name__ == '__main__':
    app()
