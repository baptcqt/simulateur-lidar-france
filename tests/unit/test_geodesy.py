from simmap.geodesy.local_frame import LocalFrame
import numpy as np
def test_roundtrip_local():
 f=LocalFrame(700000,6600000,120); p=np.array([700123.4,6600456.7,143.2]); assert np.allclose(f.from_local(f.to_local(p)),p,atol=1e-9)
def test_roundtrip_geographic():
 f=LocalFrame(700000,6600000,0); e,n,u=f.geographic_to_local(2.35,48.85,35); lon,lat,z=f.local_to_geographic(e,n,u); assert abs(lon-2.35)<1e-8 and abs(lat-48.85)<1e-8 and z==35
