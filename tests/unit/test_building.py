from simmap.buildings.reconstruct import building_lod2
def test_closed_building():
 m=building_lod2(); assert m.is_watertight; assert m.volume>0
