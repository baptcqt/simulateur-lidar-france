import numpy as np
from simmap.terrain.mesh import terrain_mesh
def test_triangulation_no_nan():
 m=terrain_mesh(np.arange(12,dtype=float).reshape(3,4)); assert len(m.faces)==12; assert not np.isnan(m.vertices).any()
def test_continuity():
 dem=np.zeros((4,4)); a=terrain_mesh(dem); b=terrain_mesh(dem); b.apply_translation([6,0,0]); assert abs(a.bounds[1,0]-b.bounds[0,0])<1e-9
