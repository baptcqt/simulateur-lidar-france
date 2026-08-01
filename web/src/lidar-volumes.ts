import * as THREE from 'three';
import * as itowns from 'itowns';

type RuntimeState = {
  view?: any;
  layers: Map<string, any>;
};

type BuildingVolume = {
  id: string;
  crs: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  points: number;
  source: string;
};

type BuildingPayload = { buildings?: BuildingVolume[] };

declare global {
  interface Window {
    __SIM_ITOWNS__?: RuntimeState;
  }
}

const LAMBERT_93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs';
const BUILDING_GROUP_NAME = 'SIM_LIDAR_BUILDING_VOLUMES';
const MAX_RENDERED_VOLUMES = 450;

function readBuildingsUrl(): string | null {
  const value = new URL(window.location.href).searchParams.get('buildings');
  if (!value) return null;
  const url = new URL(value, window.location.href);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return url.toString();
}

async function waitForView(): Promise<any> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 30_000) {
    const view = window.__SIM_ITOWNS__?.view;
    if (view?.scene && view?.referenceCrs) return view;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error('La vue iTowns n’est pas disponible pour les volumes LiDAR.');
}

async function loadBuildings(url: string): Promise<BuildingVolume[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Volumes LiDAR indisponibles (${response.status}).`);
  const payload = await response.json() as BuildingPayload;
  return (payload.buildings ?? [])
    .filter((building) => Number.isFinite(building.minX) && Number.isFinite(building.maxZ))
    .slice(0, MAX_RENDERED_VOLUMES);
}

function projectCorner(volume: BuildingVolume, x: number, y: number, z: number, targetCrs: string): THREE.Vector3 {
  const sourceCrs = volume.crs || 'EPSG:2154';
  if (sourceCrs === 'EPSG:2154') itowns.CRS.defs('EPSG:2154', LAMBERT_93);
  return new itowns.Coordinates(sourceCrs, x, y, z).as(targetCrs).toVector3(new THREE.Vector3());
}

function projectedBox(volume: BuildingVolume, targetCrs: string): THREE.Box3 {
  const box = new THREE.Box3().makeEmpty();
  for (const x of [volume.minX, volume.maxX]) {
    for (const y of [volume.minY, volume.maxY]) {
      for (const z of [volume.minZ, volume.maxZ]) {
        box.expandByPoint(projectCorner(volume, x, y, z, targetCrs));
      }
    }
  }
  return box;
}

function installVisibilityControl(group: THREE.Group, count: number): void {
  const switches = document.querySelector<HTMLElement>('.layer-switches');
  if (!switches || document.querySelector('#buildings-visible')) return;

  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.id = 'buildings-visible';
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  label.append(checkbox, ` Volumes LiDAR (${count})`);
  switches.appendChild(label);

  checkbox.addEventListener('change', () => {
    group.visible = checkbox.checked;
    window.__SIM_ITOWNS__?.view?.notifyChange(group);
  });
}

function setToolMessage(message: string): void {
  const target = document.querySelector<HTMLElement>('#itowns-tool-result');
  if (target) target.textContent = message;
}

function addBuildingVolumes(view: any, buildings: BuildingVolume[]): THREE.Group {
  const existing = view.scene.getObjectByName?.(BUILDING_GROUP_NAME);
  if (existing) view.scene.remove(existing);

  const group = new THREE.Group();
  group.name = BUILDING_GROUP_NAME;
  const material = new THREE.MeshBasicMaterial({
    color: 0xb9b29f,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  });

  for (const building of buildings) {
    const box = projectedBox(building, view.referenceCrs);
    const size = box.getSize(new THREE.Vector3());
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) continue;
    const center = box.getCenter(new THREE.Vector3());
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = building.id;
    mesh.position.copy(center);
    mesh.userData = { ...building };
    group.add(mesh);
  }

  view.scene.add(group);
  view.notifyChange(group);
  return group;
}

async function installLidarVolumes(): Promise<void> {
  const buildingsUrl = readBuildingsUrl();
  if (!buildingsUrl) return;
  const [view, buildings] = await Promise.all([waitForView(), loadBuildings(buildingsUrl)]);
  if (buildings.length === 0) {
    setToolMessage('Aucun volume bâtiment LiDAR détecté dans cette sélection.');
    return;
  }
  const group = addBuildingVolumes(view, buildings);
  installVisibilityControl(group, group.children.length);
  setToolMessage(`${group.children.length.toLocaleString('fr-FR')} volume(s) bâtiment généré(s) uniquement depuis les points LiDAR classés bâtiment.`);
}

void installLidarVolumes().catch((error: unknown) => {
  console.warn('[Volumes LiDAR]', error);
  const message = error instanceof Error ? error.message : String(error);
  setToolMessage(`Volumes LiDAR indisponibles : ${message}`);
});
