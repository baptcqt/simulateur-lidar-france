import numpy as np

def make_demo_points(seed=7):
 rng=np.random.default_rng(seed); chunks=[]
 # ground class 2
 xy=rng.uniform([0,0],[200,150],(4000,2)); z=1+0.012*xy[:,0]+0.004*xy[:,1]+rng.normal(0,.08,len(xy)); chunks.append(np.c_[xy,z,np.full(len(xy),2)])
 # building class 6
 xy=rng.uniform([70,65],[102,89],(1200,2)); ridge=15-np.abs(xy[:,1]-77)*5/12; z=ridge+rng.normal(0,.06,len(xy)); chunks.append(np.c_[xy,z,np.full(len(xy),6)])
 # vegetation class 5
 for x,y,h,r in [(35,90,12,4),(50,105,16,5),(145,85,14,4.5),(160,110,18,6)]:
  n=500; phi=rng.uniform(0,2*np.pi,n); rad=r*np.sqrt(rng.random(n)); zz=rng.uniform(h*.35,h,n)+1
  chunks.append(np.c_[x+rad*np.cos(phi),y+.85*rad*np.sin(phi),zz,np.full(n,5)])
 return np.vstack(chunks).astype(np.float32)
