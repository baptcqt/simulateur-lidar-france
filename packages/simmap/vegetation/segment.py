import numpy as np
import trimesh

def demo_trees(fidelity=50):
    specs=[(35,90,12,4),(50,105,16,5),(145,85,14,4.5),(160,110,18,6)]
    out=[]; seg=max(6,6+fidelity//10)
    for i,(x,y,h,r) in enumerate(specs):
      trunk=trimesh.creation.cylinder(radius=max(.25,r*.10),height=h*.55,sections=seg)
      trunk.apply_translation([x,y,h*.275+1])
      crown=trimesh.creation.icosphere(subdivisions=1 if fidelity<70 else 2,radius=1)
      crown.apply_scale([r,r*.85,h*.32]); crown.apply_translation([x,y,1+h*.7])
      out.append((i,trimesh.util.concatenate([trunk,crown]),{"height":h,"crown_radius":r,"measured":"position,height,envelope","procedural":"trunk,branches"}))
    return out
