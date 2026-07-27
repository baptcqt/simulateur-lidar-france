from simmap.exporters.demo_build import build_demo
import trimesh, json
def test_end_to_end(tmp_path):
 r=build_demo(tmp_path/'demo',fidelity=40); p=tmp_path/'demo'; assert (p/'chunks/chunk_0.glb').exists(); assert (p/'quality/report.html').exists(); assert trimesh.load(p/'chunks/chunk_0.glb',force='scene').geometry; assert json.loads((p/'manifest.json').read_text())['parameters']['fidelity']==40
