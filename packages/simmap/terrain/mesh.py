import numpy as np
import trimesh

def terrain_mesh(dem: np.ndarray, cell: float=2.0) -> trimesh.Trimesh:
    rows,cols=dem.shape
    xs,ys=np.meshgrid(np.arange(cols)*cell,np.arange(rows)*cell)
    vertices=np.column_stack([xs.ravel(),ys.ravel(),dem.ravel()])
    faces=[]
    for r in range(rows-1):
      for c in range(cols-1):
       a=r*cols+c; b=a+1; d=(r+1)*cols+c; e=d+1
       faces += [[a,b,e],[a,e,d]]
    return trimesh.Trimesh(vertices=vertices,faces=np.asarray(faces),process=False)
