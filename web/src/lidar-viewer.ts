import * as THREE from 'three';
import * as itowns from 'itowns';
import { Navigation, Scale } from 'itowns/widgets';
import './lidar-viewer.css';

const viewer = requireElement<HTMLDivElement>('#lidar-viewer');
const status = requireElement<HTMLDivElement>('#lidar-page-status');
const backButton = requireElement<HTMLButtonElement>('#back-to-map');
const controlPanel = requireElement<HTMLElement>('#lidar-controls');
const controlPanelBody = requireElement<HTMLDivElement>('#lidar-controls-body');
const toggleControlsButton = requireElement<HTMLButtonElement>('#toggle-lidar-controls');
const view3DButton = requireElement<HTMLButtonElement>('#view-3d');
const viewTopButton = requireElement<HTMLButtonElement>('#view-top');
const viewFitButton = requireElement<HTMLButtonElement>('#view-fit');
const renderModeSelect = requireElement<HTMLSelectElement>('#lidar-render-mode');
const pointSizeInput = requireElement<HTMLInputElement>('#lidar-point-size');
const pointSizeValue = requireElement<HTMLOutputElement>('#lidar-point-size-value');
const opacityInput = requireElement<HTMLInputElement>('#lidar-opacity');
const opacityValue = requireElement<HTMLOutputElement>('#lidar-opacity-value');
const pointBudgetInput = requireElement<HTMLInputElement>('#lidar-point-budget');
const pointBudgetValue = requireElement<HTMLOutputElement>('#lidar-point-budget-value');
const lidarVisibleInput = requireElement<HTMLInputElement>('#lidar-visible');
const orthoVisibleInput = requireElement<HTMLInputElement>('#ortho-visible');
const terrainVisibleInput = requireElement<HTMLInputElement>('#terrain-visible');
const liveStats = requireElement<HTMLDivElement>('#lidar-live-stats');

const LAMBERT_93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs';
const WMTS_URL = (import.meta.env.VITE_IGN_WMTS_URL as string | undefined) ?? 'https://data.geopf.fr/wmts';
const ORTHO_LAYER = (import.meta.env.VITE_IGN_ORTHO_LAYER as string | undefined) ?? 'ORTHOIMAGERY.ORTHOPHOTOS';
const POINT_TIMEOUT_MS = 10_000;
const ROOT_LOAD_TIMEOUT_MS = 60_000;
const DEFAULT_POINT_SIZE = 1.5;
const DEFAULT_OPACITY = 0.8;
const DEFAULT_POINT_BUDGET = 4_000_000;

const RENDER_MODES: Record<string, number> = {
  color: itowns.PNTS_MODE.COLOR,
  intensity: itowns.PNTS_MODE.INTENSITY,
  classification: itowns.PNTS_MODE.CLASSIFICATION,
  elevation: itowns.PNTS_MODE.ELEVATION,
};

type PageState = 'loading' | 'success' | 'error';
type PointStats = { points: number; nodes: number };
type CopcFrame = {
  center: any;
  range3D: number;
  rangeTop: number;
};
type AdaptedCopcNode = any & { nativeBbox?: THREE.Box3 };
type ViewerContext = {
  view: any;
  layer: any;
  orthoLayer: any;
  terrainLayer: any;
  frame: CopcFrame;
};

let context: ViewerContext | null = null;
let statsTimer: number | undefined;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Élément ${selector} introuvable.`);
  return element;
}

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
  const diagonal = Math.max(1, Math.hypot(width, height));
  const center = new itowns.Coordinates(source.crs, centerX, centerY, centerZ).as('EPSG:4326');

  return {
    center,
    range3D: Math.max(450, diagonal * 0.58),
    rangeTop: Math.max(900, diagonal * 1.05),
  };
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

function hasPointColors(layer: any): boolean {
  let found = false;
  layer.group?.traverse((object: any) => {
    if (object.isPoints && object.geometry?.getAttribute('color')) found = true;
  });
  return found;
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

function formatPointBudget(value: number): string {
  return `${(value / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} M`;
}

function updateControlLabels(): void {
  pointSizeValue.value = Number(pointSizeInput.value).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  opacityValue.value = `${Math.round(Number(opacityInput.value) * 100)} %`;
  pointBudgetValue.value = formatPointBudget(Number(pointBudgetInput.value));
}

function setPointRenderingMode(modeName: string): void {
  if (!context) return;
  const mode = RENDER_MODES[modeName];
  if (mode === undefined) return;

  context.layer.mode = mode;
  context.layer.material.mode = mode;
  context.layer.material.needsUpdate = true;
  context.view.notifyChange(context.layer);
}

function applyPointStyle(): void {
  if (!context) return;
  const pointSize = Number(pointSizeInput.value);
  const opacity = Number(opacityInput.value);
  const pointBudget = Number(pointBudgetInput.value);

  context.layer.pointSize = pointSize;
  context.layer.opacity = opacity;
  context.layer.pointBudget = pointBudget;
  context.layer.material.opacity = opacity;
  context.layer.material.depthTest = true;
  context.layer.material.depthWrite = false;
  context.layer.material.transparent = opacity < 1;
  context.layer.material.needsUpdate = true;
  context.view.notifyChange(context.layer);
  updateControlLabels();
}

async function setCamera(mode: '3d' | 'top'): Promise<void> {
  if (!context) return;
  const { view, frame } = context;
  await view.controls.lookAtCoordinate({
    coord: frame.center,
    range: mode === '3d' ? frame.range3D : frame.rangeTop,
    tilt: mode === '3d' ? 32 : 89.5,
    heading: mode === '3d' ? 28 : 0,
    time: 650,
  });
  view.notifyChange(view.camera3D);
}

function installITownsWidgets(view: any): void {
  const navigation = new Navigation(view, {
    position: 'bottom-right',
    direction: 'column',
    animationDuration: 450,
  });
  if (navigation.compass) navigation.compass.title = 'Orienter vers le nord';
  if (navigation.toggle3D) navigation.toggle3D.title = 'Basculer entre vue 2D et 3D';
  if (navigation.zoomIn) navigation.zoomIn.title = 'Zoomer';
  if (navigation.zoomOut) navigation.zoomOut.title = 'Dézoomer';

  const scale = new Scale(view, {
    position: 'bottom-left',
    width: 160,
  });
  window.setTimeout(() => scale.update(), 300);
}

function updateLiveStats(): void {
  if (!context) return;
  const stats = countPoints(context.layer);
  const budget = Number(context.layer.pointBudget ?? DEFAULT_POINT_BUDGET);
  liveStats.textContent = stats.points > 0
    ? `${stats.points.toLocaleString('fr-FR')} points visibles · ${stats.nodes.toLocaleString('fr-FR')} blocs · budget ${formatPointBudget(budget)}`
    : 'iTowns charge les blocs LiDAR visibles…';
}

function startLiveStats(): void {
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  updateLiveStats();
  statsTimer = window.setInterval(updateLiveStats, 500);
}

function bindViewerControls(): void {
  renderModeSelect.addEventListener('change', () => setPointRenderingMode(renderModeSelect.value));
  pointSizeInput.addEventListener('input', applyPointStyle);
  opacityInput.addEventListener('input', applyPointStyle);
  pointBudgetInput.addEventListener('input', applyPointStyle);

  lidarVisibleInput.addEventListener('change', () => {
    if (!context) return;
    context.layer.visible = lidarVisibleInput.checked;
    context.view.notifyChange(context.layer);
  });
  orthoVisibleInput.addEventListener('change', () => {
    if (!context) return;
    context.orthoLayer.visible = orthoVisibleInput.checked;
    context.view.notifyChange(context.orthoLayer);
  });
  terrainVisibleInput.addEventListener('change', () => {
    if (!context) return;
    context.terrainLayer.visible = terrainVisibleInput.checked;
    context.view.notifyChange(context.terrainLayer);
  });

  view3DButton.addEventListener('click', () => void setCamera('3d'));
  viewTopButton.addEventListener('click', () => void setCamera('top'));
  viewFitButton.addEventListener('click', () => void setCamera('3d'));

  toggleControlsButton.addEventListener('click', () => {
    const collapsed = controlPanel.classList.toggle('collapsed');
    controlPanelBody.hidden = collapsed;
    toggleControlsButton.textContent = collapsed ? '+' : '−';
    toggleControlsButton.setAttribute('aria-expanded', String(!collapsed));
    toggleControlsButton.title = collapsed ? 'Afficher les réglages' : 'Replier les réglages';
  });
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

  setStatus('loading', `Création de la GlobeView iTowns${fileSize ? ` — ${(fileSize / 1024 / 1024).toFixed(1)} Mo` : ''}…`);
  const view = new itowns.GlobeView(viewer, {
    coord: frame.center,
    range: frame.rangeTop,
    tilt: 89.5,
    heading: 0,
  }, {
    realisticLighting: false,
  });

  view.mainLoop.gfxEngine.renderer.setClearColor(0x9bb7cc);
  const orthoLayer = createOrthoLayer();
  const terrainLayer = createElevationLayer();
  await Promise.all([
    view.addLayer(orthoLayer),
    view.addLayer(terrainLayer),
  ]);

  let workerError: Error | null = null;
  const defaultMode = itowns.PNTS_MODE.CLASSIFICATION;
  const layer = new itowns.CopcLayer('COPC', {
    source,
    crs: view.referenceCrs,
    sseThreshold: 0.9,
    pointBudget: DEFAULT_POINT_BUDGET,
    pointSize: DEFAULT_POINT_SIZE,
    mode: defaultMode,
    opacity: DEFAULT_OPACITY,
    material: {
      mode: defaultMode,
      size: DEFAULT_POINT_SIZE,
      opacity: DEFAULT_OPACITY,
      depthTest: true,
      depthWrite: false,
      transparent: true,
    },
  });
  layer.addEventListener('load-error', (event: any) => {
    if (event?.error?.isCancelledCommandException) return;
    workerError = new Error(`Décodage LiDAR impossible : ${errorMessage(event?.error)}`);
  });

  setStatus('loading', 'Ajout de la CopcLayer et préparation du LOD iTowns…');
  await (itowns.View.prototype.addLayer.call(view, layer) as Promise<any>);
  await layer.whenReady;
  adaptCopcLayerToGlobe(layer, source, view.referenceCrs);

  context = { view, layer, orthoLayer, terrainLayer, frame };
  renderModeSelect.value = 'classification';
  pointSizeInput.value = String(DEFAULT_POINT_SIZE);
  opacityInput.value = String(DEFAULT_OPACITY);
  pointBudgetInput.value = String(DEFAULT_POINT_BUDGET);
  updateControlLabels();
  setPointRenderingMode('classification');
  applyPointStyle();
  installITownsWidgets(view);

  await setCamera('3d');
  view.notifyChange(layer);

  const firstStats = await waitForPoints(view, layer, () => workerError);
  const colorOption = renderModeSelect.querySelector<HTMLOptionElement>('option[value="color"]');
  if (colorOption && !hasPointColors(layer)) {
    colorOption.disabled = true;
    colorOption.textContent = 'Couleurs source indisponibles';
  }

  startLiveStats();
  setStatus(
    'success',
    `${label} — visionneuse iTowns active, ${firstStats.points.toLocaleString('fr-FR')} points chargés. Zoomez pour augmenter le niveau de détail.`,
  );

  window.addEventListener('resize', () => {
    view.resize?.();
    view.notifyChange(view.camera3D);
  });
}

bindViewerControls();
backButton.addEventListener('click', () => {
  if (window.history.length > 1) window.history.back();
  else window.location.assign('/');
});

window.addEventListener('beforeunload', () => {
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
});

void openCopc().catch((error: unknown) => {
  console.error('[Visionneuse terrain LiDAR iTowns]', error);
  setStatus('error', errorMessage(error));
  liveStats.textContent = 'La visionneuse n’a pas pu initialiser le nuage LiDAR.';
});
