import trimesh

def demo_bridge():
    m=trimesh.creation.box(extents=[18,8,1]); m.apply_translation([125,42,5]); return m
