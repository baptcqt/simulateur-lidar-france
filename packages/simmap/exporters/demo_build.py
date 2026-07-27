from pathlib import Path
import json, numpy as np, trimesh
from simmap.config.profiles import resolve_profile
from simmap.pointcloud.demo import make_demo_points
from simmap.terrain.mesh import terrain_mesh
from simmap.buildings.reconstruct import building_lod2
from simmap.roads.extract import demo_surfaces
from simmap.vegetation.segment import demo_trees
from simmap.bridges.build import demo_bridge
from simmap.quality.report import write as write_quality
from simmap.catalog.manifest import write_manifest

def _extrude(poly,height,z):
 minx,miny,maxx,maxy=poly.bounds
 m=trimesh.creation.box(extents=[maxx-minx,maxy-miny,height])
 m.apply_translation([(minx+maxx)/2,(miny+maxy)/2,z+height/2])
 return m

def build_demo(out: Path, profile='surface', fidelity=45):
 out=Path(out); (out/'source').mkdir(parents=True,exist_ok=True); (out/'chunks').mkdir(exist_ok=True); (out/'godot').mkdir(exist_ok=True); (out/'gazebo').mkdir(exist_ok=True)
 params=resolve_profile(profile,fidelity)
 x=np.arange(0,202,2); y=np.arange(0,152,2); xx,yy=np.meshgrid(x,y); dem=(1+.012*xx+.004*yy+.5*np.sin(xx/35)).astype(np.float32)
 np.save(out/'source'/'dem.npy',dem); pts=make_demo_points(); np.save(out/'source'/'points.npy',pts)
 scene=trimesh.Scene(); scene.add_geometry(terrain_mesh(dem,2),node_name='terrain'); scene.add_geometry(building_lod2(),node_name='building_lod2')
 for name,p in demo_surfaces().items(): scene.add_geometry(_extrude(p,.15,2.0),node_name=name)
 for i,m,meta in demo_trees(fidelity): scene.add_geometry(m,node_name=f'tree_{i}')
 scene.add_geometry(demo_bridge(),node_name='bridge_deck')
 scene.export(out/'chunks'/'chunk_0.glb')
 objects={"type":"FeatureCollection","features":[{"type":"Feature","properties":{"kind":"building","mode":"lod2_simplified","confidence":0.78},"geometry":{"type":"Polygon","coordinates":[[[70,65],[102,65],[102,89],[70,89],[70,65]]]}},{"type":"Feature","properties":{"kind":"private_access","confidence":0.62},"geometry":{"type":"Polygon","coordinates":[[[78,49],[89,49],[89,70],[78,70],[78,49]]]}}]}
 (out/'objects.geojson').write_text(json.dumps(objects,indent=2),encoding='utf-8')
 (out/'attribution.txt').write_text("Démonstration synthétique, aucune donnée IGN redistribuée. Pour des données réelles, conserver les attributions du produit IGN dans le manifeste.\n",encoding='utf-8')
 (out/'godot'/'map.json').write_text(json.dumps({"chunks":[{"path":"../chunks/chunk_0.glb","bbox":[0,0,0,200,150,25],"lod":0}],"local_origin":[0,0,0]},indent=2),encoding='utf-8')
 (out/'gazebo'/'world.sdf').write_text('<?xml version="1.0"?><sdf version="1.9"><world name="simmap"><gravity>0 0 -9.81</gravity><model name="terrain"><static>true</static><link name="link"><collision name="collision"><geometry><box><size>200 150 1</size></box></geometry></collision><visual name="visual"><geometry><box><size>200 150 1</size></box></geometry></visual></link></model></world></sdf>',encoding='utf-8')
 report=write_quality(out)
 manifest=write_manifest(out,params,[{"name":"demo-synthetic","role":"test","acquisition_year":2026,"license":"CC0-like generated fixture; repository Apache-2.0"}])
 return {"project":str(out),"report":report,"manifest":manifest}
