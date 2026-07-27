from shapely.geometry import Polygon

def demo_surfaces():
    road=Polygon([(0,35),(200,35),(200,49),(0,49)])
    access=Polygon([(78,49),(89,49),(89,70),(78,70)])
    return {"road":road,"private_access":access}
