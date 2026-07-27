from pathlib import Path
def test_no_osm_dependency():
 forbidden='open'+'streetmap'
 files=['pyproject.toml','package.json','apps/web/package.json','configs/ign-resources.yml']
 assert all(forbidden not in Path(f).read_text(encoding='utf-8').lower() for f in files)
