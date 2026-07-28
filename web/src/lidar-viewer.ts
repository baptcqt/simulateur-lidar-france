import * as THREE from 'three';
import * as itowns from 'itowns';
import './lidar-viewer.css';

const viewer = document.querySelector<HTMLDivElement>('#lidar-viewer');
const status = document.querySelector<HTMLDivElement>('#lidar-page-status');
const backButton = document.querySelector<HTMLButtonElement>('#back-to-map');

if (!viewer || !status || !backButton) {
  throw new Error('La page LiDAR est incomplète.');
}

const LAMBERT_93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs';
const POINT_TIMEOUT_MS = 45_000;

type PageState = 'loading' | 'success' | 'error';

type PointStats = {
  points: number;
  nodes: number;
};

function setStatus(state: PageState, message: string): void {
  status.className = state;
  status.textContent = message;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertBrowserCapabilities(): void {
  if (typeof WebAssembly === 'undefined') {
    throw new Error('WebAssembly est désactivé dans ce navigateur.');
  }
  if (typeof Worker === 'undefined') {
    throw new Error('Les Web Workers sont désactivés dans ce navigateur.');
  }
  const canvas = document.createElement('canvas');
  if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) {
    throw new Error('WebGL est désactivé. Activez l’accélération graphique du navigateur.');
  }
}

async function probeCopc(url: string): Promise<number | null> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-374' } });
  if (response.status !== 206) {
    throw new Error(`Le serveur n’accepte pas les lectures partielles nécessaires au COPC (HTTP ${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 4));
  if (signature !== 'LASF') {
    throw new Error('Le fichier sélectionné n’est pas un fichier LAS/COPC valide.');
  }
  const range = response.headers.get('Content-Range');
  const total = range?.match(/\/(\d+)$/)?.[1];
  return total ? Number(total) : null;
}

function isIgnLambert93(url: string, label: string): boolean {
  const value = `${url} ${label}`.toUpperCase();
  return value.includes('LAMB93') || value.includes('IGN69');
}

function normalizeSourceCrs(source: any, url: string, label: string): string {
  // Les COPC IGN portent souvent un CRS composé Lambert-93 + altitude IGN69.
  // iTowns ne conserve que la partie horizontale des CRS composés. On utilise
  // explicitement EPSG:2154 afin que le parser LAZ, la couche et la caméra
  // travaillent tous dans le même référentiel métrique.
  if (isIgnLambert93(url, label)) {
    itowns.CRS.defs('EPSG:2154', LAMBERT_93);
    source.crs = 'EPSG:2154';
    return 'EPSG:2154';
  }
  if (!source.crs) {
    throw new Error('Le système de coordonnées du COPC est introuvable.');
  }
  return source.crs;
}

function zoomToLayer(view: any, layer: any): void {
  const obb = layer.root?.voxelOBB;
  if (!obb) throw new Error('L’emprise 3D du COPC est indisponible.');

  // Même cadrage que examples/jsm/PointCloudHelper.js dans iTowns.
  const center = obb.box3D.getCenter(new THREE.Vector3());
  obb.localToWorld(center);
  const length = obb.box3D.getSize(new THREE.Vector3()).length();
  const camera = view.camera3D as THREE.PerspectiveCamera;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const radius = Math.max(length / 2, 1);
  const distance = radius / Math.tan(fov / 2);

  camera.position.copy(center).addScaledVector(new THREE.Vector3(0, 0, 1), distance);
  camera.up.set(0, 1, 0);
  camera.near = Math.max(distance / 100_000, 0.1);
  camera.far = Math.max(2 * distance, 1_000);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  view.notifyChange(camera);
}

function countPoints(layer: any): PointStats {
  let points = 0;
  let nodes = 0;
  layer.group?.traverse((object: any) => {
    if (!object.isPoints) return;
    nodes += 1;
    points += object.geometry?.getAttribute('position')?.count ?? 0;
  });
  return { points, nodes };
}

async function waitForPoints(view: any, layer: any, loadError: () => Error | null): Promise<PointStats> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < POINT_TIMEOUT_MS) {
    const error = loadError();
    if (error) throw error;

    const stats = countPoints(layer);
    if (stats.points > 0 || Number(layer.displayedCount) > 0) {
      return {
        points: Math.max(stats.points, Number(layer.displayedCount) || 0),
        nodes: stats.nodes,
      };
    }

    view.notifyChange(view.camera3D);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  const rootPoints = Number(layer.root?.numPoints ?? 0);
  throw new Error(`iTowns a lu l’octree, mais aucun bloc de points n’a été rendu. Racine annoncée : ${rootPoints.toLocaleString('fr-FR')} points.`);
}

async function openCopc(): Promise<void> {
  const params = new URL(window.location.href).searchParams;
  const url = params.get('copc');
  const label = params.get('label') || 'Dalle COPC';
  if (!url) throw new Error('Aucune URL COPC n’a été fournie à la vue iTowns.');

  const parsedUrl = new URL(url, window.location.href);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('L’URL COPC doit utiliser HTTP ou HTTPS.');
  }

  assertBrowserCapabilities();
  setStatus('loading', `Vérification de ${label}…`);
  const fileSize = await probeCopc(parsedUrl.toString());

  itowns.LASParser.enableLazPerf('/laz-perf');

  // Structure volontairement identique au chargeur COPC simple officiel.
  const view = new itowns.View('EPSG:4326', viewer);
  const controls = new itowns.PlanarControls(view);
  void controls;
  view.mainLoop.gfxEngine.renderer.setClearColor(0x202225);

  setStatus('loading', `Lecture des métadonnées COPC${fileSize ? ` — ${(fileSize / 1024 / 1024).toFixed(1)} Mo` : ''}…`);
  const source = new itowns.CopcSource({ url: parsedUrl.toString() });
  await source.whenReady;

  const crs = normalizeSourceCrs(source, parsedUrl.toString(), label);
  view.referenceCrs = crs;
  view.camera.crs = crs;

  let workerError: Error | null = null;
  const layer = new itowns.CopcLayer('COPC', {
    source,
    sseThreshold: 2,
    pointBudget: 3_000_000,
    pointSize: 2,
    mode: itowns.PNTS_MODE.INTENSITY,
  });

  layer.addEventListener('load-error', (event: any) => {
    if (event?.error?.isCancelledCommandException) return;
    workerError = new Error(`Le worker LAZ iTowns a échoué : ${errorMessage(event?.error)}`);
  });

  setStatus('loading', `Ouverture de ${label} dans iTowns…`);
  await view.addLayer(layer);
  zoomToLayer(view, layer);

  const stats = await waitForPoints(view, layer, () => workerError);
  setStatus('success', `${label} — ${stats.points.toLocaleString('fr-FR')} points chargés dans iTowns.`);

  window.addEventListener('resize', () => {
    view.resize?.();
    view.notifyChange(view.camera3D);
  });
}

backButton.addEventListener('click', () => {
  if (window.history.length > 1) window.history.back();
  else window.location.assign('/');
});

void openCopc().catch((error: unknown) => {
  const message = errorMessage(error);
  console.error('[Vue COPC iTowns]', error);
  setStatus('error', message);
});
