from dataclasses import dataclass, asdict

@dataclass(frozen=True)
class Profile:
    name: str; chunk_m: int; voxel_m: float; point_fraction: float; dem_resolution_m: float
    simplify_tolerance_m: float; roof_planes_max: int; tree_segments: int; texture_px: int

PROFILES = {
 "surface": Profile("surface",250,0.50,0.20,1.0,0.30,4,8,1024),
 "standard": Profile("standard",250,0.25,0.50,0.5,0.15,8,12,2048),
 "quality": Profile("quality",125,0.10,1.00,0.25,0.05,16,20,4096),
}

def resolve_profile(name: str, fidelity: int) -> dict:
    if name not in PROFILES: raise ValueError(f"Profil inconnu: {name}")
    f=max(0,min(100,fidelity))/100
    p=asdict(PROFILES[name])
    p.update({
      "fidelity": int(fidelity),
      "voxel_m": round(p["voxel_m"]*(1.4-0.8*f),3),
      "point_fraction": round(min(1.0,p["point_fraction"]*(0.5+f)),3),
      "simplify_tolerance_m": round(p["simplify_tolerance_m"]*(1.5-f),3),
      "tree_segments": max(6,int(p["tree_segments"]*(0.5+f))),
      "lod_distances_m": [100, 250, 600],
      "collision_complexity": "low" if fidelity < 50 else "medium" if fidelity < 80 else "high",
    })
    return p
