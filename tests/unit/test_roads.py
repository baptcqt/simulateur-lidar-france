from simmap.roads.extract import demo_surfaces
def test_private_access_connected():
 s=demo_surfaces(); assert s['road'].intersects(s['private_access'])
