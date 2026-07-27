from dataclasses import dataclass
import numpy as np
from pyproj import CRS, Transformer

@dataclass
class LocalFrame:
    origin_x: float; origin_y: float; origin_z: float; source_crs: str = "EPSG:2154"
    def to_local(self, xyz):
        a=np.asarray(xyz,dtype=float); return a-np.array([self.origin_x,self.origin_y,self.origin_z])
    def from_local(self, enu):
        a=np.asarray(enu,dtype=float); return a+np.array([self.origin_x,self.origin_y,self.origin_z])
    def geographic_to_local(self, lon, lat, alt=0.0):
        t=Transformer.from_crs(CRS.from_epsg(4326), self.source_crs, always_xy=True)
        x,y=t.transform(lon,lat); return tuple(self.to_local([x,y,alt]))
    def local_to_geographic(self, e,n,u=0.0):
        x,y,z=self.from_local([e,n,u]); t=Transformer.from_crs(self.source_crs,CRS.from_epsg(4326),always_xy=True)
        lon,lat=t.transform(x,y); return lon,lat,z
