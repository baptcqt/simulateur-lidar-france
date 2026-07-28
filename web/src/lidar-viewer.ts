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
const WMTS_URL = (import.meta.env.VITE_IGN_WMTS_URL as string | undefined) ?? 'https://data.geopf.fr/wmts';
const ORTHO_LAYER = (import.meta.env.VITE_IGN_ORTHO_LAYER as string | undefined) ?? 'ORTHOIMAGERY.ORTHOPHOTOS';
const POINT_TIMEOUT_MS = 8_000;
const ROOT_LOAD_TIMEOUT_MS = 60_000;

type PageState = 'loading' | 'success' | 'error';
type PointStats = { points: number; nodes: number };
type CopcFrame = { center: any; range: number };
type AdaptedCopcNode = any & { nativeBbox?: THREE.Box3 };

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
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly est désactivé dans ce navigateur.');
  if (typeof Worker === 'undefined') throw new Error('Les Web Workers sont désactivés dans ce navigateur.');
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
  if (new TextDecoder('ascii').decode(bytes.slice(0, 4)) !== 'LASF') {
    throw new Error('Le fichier sélectionné n’est pas un fichier LAS/COPC valide.');
  }
  const total = response.headers.get('Content-Range')?.match(/\/(\d+)$/)?.[1];
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
  }
  if (!source.crs) throw new Error('Le système de coordonnées du COPC est introuvable.');
  return source.crs;
}

function frameFromCopc(source: any): CopcFrame {
  const cube = source.info?.cube;
  if (!Array.isArray(cube) || cube.length < 6 || !cube.slice(0, 6).every(Number.isFinite)) {
    throw new Error('L’emprise géographique du COPC est indisponible.');
  }

  const centerX = (cube[0] + cube[3]) / 2;
  const centerY = (cube[1] + cube[4]) / 2;
  const centerZ = (cube[2] + cube[5]) / 2;
  const width = Math.abs(cube[3] - cube[0]);
  const height = Math.abs(cube[4] - cube[1]);
  const center = new itowns.Coordinates(source.crs, centerX, centerY, centerZ).as('EPSG:4326');
  const range = Math.max(1_200, Math.hypot(width, height) * 1.15);
  return { center, range };
}

function createOrthoLayer(): any {
  const source = new itowns.WMTSSource({
    url: WMTS_URL,
    name: ORTHO_LAYER,
    tileMatrixSet: 'PM',
    format: 'image/jpeg',
    style: 'normal',
    crs: 'EPSG:3857',
  });
  return new itowns.ColorLayer('IGN_ORTHO', { source });
}

function createElevationLayer(): any {
  const source = new itowns.WMTSSource({
    url: `${WMTS_URL}?`,
    crs: 'EPSG:4326',
    format: 'image/x-bil;bits=32',
    name: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
    tileMatrixSet: 'WGS84G',
    tileMatrixSetLimits: {
      11: { minTileRow: 442, maxTileRow: 1267, minTileCol: 1344, maxTileCol: 2683 },
      12: { minTileRow: 885, maxTileRow: 2343, minTileCol: 3978, maxTileCol: 5126 },
      13: { minTileRow: 1770, maxTileRow: 4687, minTileCol: 7957, maxTileCol: 10253 },
      14: { minTileRow: 3540, maxTileRow: 9375, minTileCol: 15914, maxTileCol: 20507 },
    },
  });

  return new itowns.ElevationLayer('IGN_MNT_HIGHRES', {
    source,
    noDataValue: -99999,
    clampValues: { min: 0 },
    updateStrategy: { type: 1, options: { groups: [11, 14] } },
  } as any);
}

function projectPoint(point: THREE.Vector3, sourceCrs: string, targetCrs: string): THREE.Vector3 {
  return new itowns.Coordinates(sourceCrs, point.x, point.y, point.z)
    .as(targetCrs)
    .toVector3(new THREE.Vector3());
}

function projectBox3(box: THREE.Box3, sourceCrs: string, targetCrs: string): THREE.Box3 {
  const projected = new THREE.Box3().makeEmpty();
  const xValues = [box.min.x, box.max.x];
  const yValues = [box.min.y, box.max.y];
  const zValues = [box.min.z, box.max.z];

  for (const x of xValues) {
    for (const y of yValues) {
      for (const z of zValues) {
        projected.expandByPoint(projectPoint(new THREE.Vector3(x, y, z), sourceCrs, targetCrs));
      }
    }
  }
  return projected;
}

function nativeChildBox(parent: AdaptedCopcNode, child: AdaptedCopcNode): THREE.Box3 {
  const parentBox = parent.nativeBbox;
  if (!parentBox) throw new Error('Emprise native du nœud COPC absente.');

  const factor = 2 ** (Number(child.depth) - Number(parent.depth));
  const childSize = parentBox.getSize(new THREE.Vector3()).divideScalar(factor);
  const parentGrid = new THREE.Vector3(Number(parent.x), Number(parent.y), Number(parent.z)).multiplyScalar(factor);
  const childGrid = new THREE.Vector3(Number(child.x), Number(child.y), Number(child.z));
  const offset = childGrid.sub(parentGrid).multiply(childSize);
  const min = parentBox.min.clone().add(offset);
  return new THREE.Box3(min, min.clone().add(childSize));
}

function adaptCopcNodeToGlobe(
  node: AdaptedCopcNode,
  parent: AdaptedCopcNode | null,
  sourceCrs: string,
  targetCrs: string,
  rootCube?: number[],
): void {
  const nativeBox = parent
    ? nativeChildBox(parent, node)
    : new THREE.Box3(
      new THREE.Vector3(rootCube?.[0], rootCube?.[1], rootCube?.[2]),
      new THREE.Vector3(rootCube?.[3], rootCube?.[4], rootCube?.[5]),
    );

  node.nativeBbox = nativeBox;
  node.bbox.copy(projectBox3(nativeBox, sourceCrs, targetCrs));

  // iTowns 2.46 calcule les enfants à partir de bbox. Après projection globe,
  // cette bbox est géocentrique : on conserve donc séparément le cube Lambert
  // pour les subdivisions et on projette chaque enfant vers le CRS de la vue.
  node.createChildAABB = (child: AdaptedCopcNode) => {
    adaptCopcNodeToGlobe(child, node, sourceCrs, targetCrs);
  };

  for (const child of node.children ?? []) {
    adaptCopcNodeToGlobe(child, node, sourceCrs, targetCrs);
  }
}

function adaptCopcLayerToGlobe(layer: any, source: any, targetCrs: string): void {
  const cube = source.info?.cube;
  if (!layer.root || !Array.isArray(cube) || cube.length < 6) {
    throw new Error('Impossible de préparer l’octree COPC pour la vue globe.');
  }
  adaptCopcNodeToGlobe(layer.root, null, source.crs, targetCrs, cube);
  layer.object3d.updateMatrixWorld(true);
}

function countPoints(layer: any): PointStats {
  let points = 0;
  let nodes = 0;
  layer.group?.traverse((object: any) => {
    if (!object.isPoints || !object.visible) return;
    const count = Number(object.geometry?.getAttribute('position')?.count ?? 0);
    if (count <= 0) return;
    points += count;
    nodes += 1;
  });
  return { points, nodes };
}

function attachRootPoints(view: any, layer: any, root: any, points: THREE.Points): PointStats {
  const count = Number(points.geometry?.getAttribute('position')?.count ?? 0);
  if (count <= 0) throw new Error('Le premier bloc LAZ ne contient aucune position.');

  root.obj = points;
  root.tightbbox = (points as any).tightbbox ?? points.geometry.boundingBox;
  root.visible = true;
  points.visible = true;
  points.frustumCulled = false;
  if (points.parent !== layer.group) layer.group.add(points);
  points.updateMatrixWorld(true);
  layer.group.updateMatrixWorld(true);
  layer.displayedCount = count;
  view.notifyChange(layer);
  return { points: count, nodes: 1 };
}

async function loadRootExplicitly(view: any, layer: any): Promise<PointStats> {
  const root = layer.root;
  if (!root) throw new Error('La racine de l’octree COPC est absente.');
  if (root.obj?.isPoints) return attachRootPoints(view, layer, root, root.obj);

  root.visible = true;
  const scheduler = view.mainLoop?.scheduler;
  if (!scheduler?.execute) throw new Error('Le scheduler pointcloud d’iTowns est indisponible.');

  const points = await withTimeout(
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
  return attachRootPoints(view, layer, root, points);
}

async function waitForPoints(view: any, layer: any, getLoadError: () => Error | null): Promise<PointStats> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < POINT_TIMEOUT_MS) {
    const loadError = getLoadError();
    if (loadError) throw loadError;
    const stats = countPoints(layer);
    if (stats.points > 0) return stats;
    view.notifyChange(view.camera3D);
    await delay(250);
  }
  return loadRootExplicitly(view, layer);
}

async function openCopc(): Promise<void> {
  const params = new URL(window.location.href).searchParams;
  const url = params.get('copc');
  const label = params.get('label') || 'Dalle COPC';
  if (!url) throw new Error('Aucune URL COPC n’a été fournie.');

  const parsedUrl = new URL(url, window.location.href);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('L’URL COPC doit utiliser HTTP ou HTTPS.');

  assertBrowserCapabilities();
  setStatus('loading', `Lecture de ${label}…`);
  const fileSize = await probeCopc(parsedUrl.toString());
  const source = new itowns.CopcSource({ url: parsedUrl.toString() });
  await source.whenReady;
  normalizeSourceCrs(source, parsedUrl.toString(), label);
  const frame = frameFromCopc(source);

  setStatus('loading', `Création du terrain IGN${fileSize ? ` — ${(fileSize / 1024 / 1024).toFixed(1)} Mo` : ''}…`);
  const view = new itowns.GlobeView(viewer, {
    coord: frame.center,
    range: frame.range,
    tilt: 55,
    heading: 0,
  }, {
    realisticLighting: false,
  });

  view.mainLoop.gfxEngine.renderer.setClearColor(0x9bb7cc);
  await Promise.all([
    view.addLayer(createOrthoLayer()),
    view.addLayer(createElevationLayer()),
  ]);

  let workerError: Error | null = null;
  const layer = new itowns.CopcLayer('COPC', {
    source,
    crs: view.referenceCrs,
    sseThreshold: 1.5,
    pointBudget: 3_000_000,
    pointSize: 3,
    mode: itowns.PNTS_MODE.CLASSIFICATION,
    opacity: 1,
  });
  layer.addEventListener('load-error', (event: any) => {
    if (event?.error?.isCancelledCommandException) return;
    workerError = new Error(`Décodage LiDAR impossible : ${errorMessage(event?.error)}`);
  });

  setStatus('loading', 'Reprojection et placement du LiDAR dans la scène iTowns…');
  await (itowns.View.prototype.addLayer.call(view, layer) as Promise<any>);
  await layer.whenReady;
  adaptCopcLayerToGlobe(layer, source, view.referenceCrs);

  // Le matériau, le LOD, le scheduler, le picking et le rendu restent ceux de
  // CopcLayer/PointCloudLayer. Seule la reprojection manquante de la 2.46 est
  // rétroportée dans notre worker et dans les boîtes de l’octree.
  layer.material.depthTest = false;
  layer.material.depthWrite = false;
  layer.material.needsUpdate = true;

  await view.controls.lookAtCoordinate({
    coord: frame.center,
    range: frame.range,
    tilt: 55,
    heading: 0,
    time: 0,
  });
  view.notifyChange(layer);

  const stats = await waitForPoints(view, layer, () => workerError);
  setStatus('success', `${label} — ${stats.points.toLocaleString('fr-FR')} points LiDAR rendus par iTowns sur le terrain IGN.`);

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
  console.error('[Vue terrain LiDAR iTowns]', error);
  setStatus('error', errorMessage(error));
});
