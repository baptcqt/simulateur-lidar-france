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
const AUTO_LOAD_GRACE_MS = 2_500;
const ROOT_LOAD_TIMEOUT_MS = 60_000;
const EXTENT_TIMEOUT_MS = 10_000;

type PageState = 'loading' | 'success' | 'error';

type PointStats = {
  points: number;
  nodes: number;
};

type CameraFrame = {
  center: THREE.Vector3;
  size: THREE.Vector3;
  origin: 'voxelOBB' | 'bbox' | 'COPC info cube';
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} : délai dépassé.`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
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

function validVector(vector: THREE.Vector3): boolean {
  return [vector.x, vector.y, vector.z].every(Number.isFinite);
}

function frameFromLayer(layer: any, source: any): CameraFrame | null {
  const obb = layer.root?.voxelOBB;
  if (obb?.box3D?.getCenter && obb?.box3D?.getSize) {
    const center = obb.box3D.getCenter(new THREE.Vector3());
    obb.localToWorld?.(center);
    const size = obb.box3D.getSize(new THREE.Vector3());
    if (validVector(center) && validVector(size) && size.length() > 0) {
      return { center, size, origin: 'voxelOBB' };
    }
  }

  const bbox = layer.root?.bbox;
  if (bbox?.getCenter && bbox?.getSize) {
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    if (validVector(center) && validVector(size) && size.length() > 0) {
      return { center, size, origin: 'bbox' };
    }
  }

  const cube = source.info?.cube;
  if (Array.isArray(cube) && cube.length >= 6 && cube.slice(0, 6).every(Number.isFinite)) {
    const box = new THREE.Box3(
      new THREE.Vector3(cube[0], cube[1], cube[2]),
      new THREE.Vector3(cube[3], cube[4], cube[5]),
    );
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    if (validVector(center) && validVector(size) && size.length() > 0) {
      return { center, size, origin: 'COPC info cube' };
    }
  }

  return null;
}

async function waitForCameraFrame(layer: any, source: any): Promise<CameraFrame> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < EXTENT_TIMEOUT_MS) {
    const frame = frameFromLayer(layer, source);
    if (frame) return frame;
    await delay(50);
  }
  throw new Error('iTowns a lu les métadonnées, mais aucune emprise 3D exploitable n’a été trouvée.');
}

function zoomToFrame(view: any, frame: CameraFrame): void {
  const length = frame.size.length();
  const camera = view.camera3D as THREE.PerspectiveCamera;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const radius = Math.max(length / 2, 1);
  const distance = radius / Math.tan(fov / 2);

  camera.position.copy(frame.center).addScaledVector(new THREE.Vector3(0, 0, 1), distance);
  camera.up.set(0, 1, 0);
  camera.near = Math.max(distance / 100_000, 0.1);
  camera.far = Math.max(2 * distance, 1_000);
  camera.lookAt(frame.center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  view.notifyChange(camera);
}

function countPoints(layer: any): PointStats {
  let points = 0;
  let nodes = 0;
  layer.group?.traverse((object: any) => {
    if (!object.isPoints) return;
    const count = Number(object.geometry?.getAttribute('position')?.count ?? 0);
    if (count <= 0) return;
    nodes += 1;
    points += count;
  });
  return { points, nodes };
}

async function waitForRenderedPoints(
  view: any,
  layer: any,
  loadError: () => Error | null,
  milliseconds: number,
): Promise<PointStats | null> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < milliseconds) {
    const error = loadError();
    if (error) throw error;

    const stats = countPoints(layer);
    if (stats.points > 0) return stats;

    view.notifyChange(view.camera3D);
    await delay(200);
  }
  return null;
}

function attachRootPoints(view: any, layer: any, root: any, points: THREE.Points): PointStats {
  const count = Number(points.geometry?.getAttribute('position')?.count ?? 0);
  if (count <= 0) {
    throw new Error('Le premier bloc LAZ a été décodé, mais sa géométrie ne contient aucune position.');
  }

  root.obj = points;
  root.visible = true;
  points.visible = true;
  points.frustumCulled = false;

  if (points.parent !== layer.group) {
    layer.group.add(points);
  }
  points.updateMatrixWorld(true);
  (points as any).matrixWorldInverse = points.matrixWorld.clone().invert();
  layer.group.updateMatrixWorld(true);
  view.scene.updateMatrixWorld(true);

  // Le LOD automatique pourra reprendre ensuite. La présence de root.obj évite
  // qu’iTowns ne redemande le même bloc.
  layer.displayedCount = count;
  layer.setNodeVisible?.(root, true);
  view.notifyChange(layer);

  return { points: count, nodes: 1 };
}

async function loadRootExplicitly(view: any, layer: any): Promise<PointStats> {
  const root = layer.root;
  if (!root) throw new Error('La racine de l’octree COPC est absente.');

  if (root.obj?.isPoints) {
    return attachRootPoints(view, layer, root, root.obj as THREE.Points);
  }

  // Une commande automatique peut avoir démarré juste avant le secours.
  if (root.promise) {
    try {
      await withTimeout(Promise.resolve(root.promise), 5_000, 'Chargement automatique de la racine');
    } catch {
      // On poursuit avec une commande explicite, qui remontera l’erreur réelle.
    }
    if (root.obj?.isPoints) {
      return attachRootPoints(view, layer, root, root.obj as THREE.Points);
    }
  }

  root.visible = true;
  const scheduler = view.mainLoop?.scheduler;
  if (!scheduler?.execute) {
    throw new Error('Le scheduler pointcloud d’iTowns est indisponible.');
  }

  let points: THREE.Points;
  try {
    points = await withTimeout(
      scheduler.execute({
        layer,
        requester: root,
        view,
        priority: Number.MAX_SAFE_INTEGER,
        redraw: true,
      }) as Promise<THREE.Points>,
      ROOT_LOAD_TIMEOUT_MS,
      'Décodage du premier bloc LAZ',
    );
  } catch (error) {
    throw new Error(`Chargement explicite de la racine COPC impossible : ${errorMessage(error)}`);
  }

  return attachRootPoints(view, layer, root, points);
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

  setStatus('loading', `Lecture des métadonnées COPC${fileSize ? ` — ${(fileSize / 1024 / 1024).toFixed(1)} Mo` : ''}…`);
  const source = new itowns.CopcSource({ url: parsedUrl.toString() });
  await source.whenReady;
  const crs = normalizeSourceCrs(source, parsedUrl.toString(), label);

  const view = new itowns.View(crs, viewer);
  const controls = new itowns.PlanarControls(view);
  view.controls = controls;
  view.mainLoop.gfxEngine.renderer.setClearColor(0x202225);

  let workerError: Error | null = null;
  const layer = new itowns.CopcLayer('COPC', {
    source,
    crs,
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
  await layer.whenReady;

  const frame = await waitForCameraFrame(layer, source);
  zoomToFrame(view, frame);
  const rootPoints = Number(layer.root?.numPoints ?? 0);
  setStatus('loading', `Emprise ${frame.origin} trouvée. Chargement automatique de ${rootPoints.toLocaleString('fr-FR')} points…`);

  let stats = await waitForRenderedPoints(view, layer, () => workerError, AUTO_LOAD_GRACE_MS);
  if (!stats) {
    setStatus('loading', `Le LOD automatique n’a pas demandé la racine. Chargement direct du premier bloc (${rootPoints.toLocaleString('fr-FR')} points)…`);
    stats = await loadRootExplicitly(view, layer);
  }

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
