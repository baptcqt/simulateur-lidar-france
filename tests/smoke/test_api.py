from fastapi.testclient import TestClient
from apps.api.main import app
def test_health_and_estimate():
 c=TestClient(app); assert c.get('/health').json()['osm_dependency'] is False; assert c.get('/profiles/surface/estimate?fidelity=45').status_code==200
