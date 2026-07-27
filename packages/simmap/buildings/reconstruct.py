import numpy as np
import trimesh

def building_lod2(x0=70,y0=65,w=32,d=24,z0=2,h=10,roof=5):
    # closed house with gable roof along X
    v=np.array([[x0,y0,z0],[x0+w,y0,z0],[x0+w,y0+d,z0],[x0,y0+d,z0],
                [x0,y0,z0+h],[x0+w,y0,z0+h],[x0+w,y0+d,z0+h],[x0,y0+d,z0+h],
                [x0,y0+d/2,z0+h+roof],[x0+w,y0+d/2,z0+h+roof]],float)
    f=np.array([[0,2,1],[0,3,2],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7],
                [4,5,9],[4,9,8],[7,8,9],[7,9,6],[4,8,7],[5,6,9]],int)
    return trimesh.Trimesh(v,f,process=True)
