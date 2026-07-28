import * as THREE from 'three';
import * as itowns from 'itowns';
import './style.css';

type BaseMode = 'topo' | 'satellite';
type CameraMode = 'flat' | 'oblique';
type TileState = 'idle' | 'searching' | 'ready' | 'loading' | 'success' | 'warning' | 'error';
type BBox4326 = { minLon: number; minLat: number; maxLon: number; maxLat: number };
type Bounds4326 = BBox4326;

type GeocodeFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { label?: string; name?: string; city?: string; postcode?: string; score?: number };
};

type GeocodeResponse = { type: 'FeatureCollection'; features?: GeocodeFeature[] };

type LidarFeature = {
  id?: string;
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
  downloadUrl?: string | null;
  isCopc?: boolean;
};

type LidarResponse = { features?: LidarFeature[] };

type DownloadJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  filename?: string;
  path?: string | null;
  bytesDownloaded?: number;
  totalBytes?: number | null;
  error?: string | null;
};

type SelectedLidarTile = {
  label: string;
  url: string;
  bounds: Bounds4326 | null;
};

type RenderStats = { points: number; nodes: number };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Élément #app introuvable');

app.innerHTML = `
  <aside class="panel">
    <h1>Simulateur LiDAR France</h1>
    <p>Carte IGN et affichage natif des nuages de points avec iTowns.</p>

    <form id="address-form" class="block compact-block">
      <label for="address">Rechercher un lieu</label>
      <div class="row">
        <input id="address" type="search" placeholder="Ex. Cléden-Cap-Sizun" autocomplete="street-address">
        <button type="submit">Rechercher</button>
      </div>
      <div id="search-results" class="results" aria-live="polite"></div>
    </form>

    <section class="block compact-block map-controls">
      <h2>Fond de carte</h2>
      <label><input name="base-mode" type="radio" value="topo" checked> BD topo / Plan IGN</label>
      <label><input name="base-mode" type="radio" value="satellite"> Satellite IGN</label>
    </section>

    <section class="block compact-block map-controls">
      <h2>Angle de la carte</h2>
      <label><input name="camera-mode" type="radio" value="flat" checked> 2D verticale</label>
      <label><input name="camera-mode" type="radio" value="oblique"> 3D légère</label>
      <button id="reset-flat" type="button">Revenir en 2D</button>
    </section>

    <section class="block lidar-block">
      <h2>LiDAR IGN</h2>
      <p class="hint">Sélectionnez une zone. La dalle correspondante sera recherchée automatiquement.</p>
      <button id="select-rectangle" type="button">Sélectionner une zone</button>

      <div id="tile-status" class="tile-status idle" aria-live="polite">
        <span class="state-dot" aria-hidden="true"></span>
        <div>
          <strong>Aucune zone sélectionnée</strong>
          <span>Sélectionnez une petite zone sur la carte.</span>
        </div>
      </div>

      <button id="display-lidar" class="primary-action" type="button" disabled>Afficher le LiDAR</button>
      <progress id="load-progress" max="1" value="0" hidden></progress>
      <button id="return-map" type="button" hidden>Revenir à la carte</button>
    </section>

    <div id="status">Initialisation…</div>
  </aside>

  <main id="viewer">
    <div id="map-surface" class="viewer-surface"></div>
    <div id="lidar-surface" class="viewer-surface lidar-surface" hidden></div>
    <div id="selection-overlay" aria-hidden="true">
      <div id="selection-rect"></div>
      <div id="selection-instruction">Glissez pour sélectionner une zone LiDAR</div>
    </div>
  </main>
`;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Élément ${selector} introuvable`);
  return element;
}

const viewerDiv = requireElement<HTMLDivElement>('#viewer');
const mapSurface = requireElement<HTMLDivElement>('#map-surface');
const lidarSurface = requireElement<HTMLDivElement>('#lidar-surface');

const statusOutput = document.querySelector<HTMLDivElement>('#status');
const searchResults = document.querySelector<HTMLDivElement>('#search-results');
const tileStatus = document.querySelector<HTMLDivElement>('#tile-status');
const selectRectangleButton = document.querySelector<HTMLButtonElement>('#select-rectangle');
const displayLidarButton = document.querySelector<HTMLButtonElement>('#display-lidar');
const returnMapButton = document.querySelector<HTMLButtonElement>('#return-map');
const loadProgress = document.querySelector<HTMLProgressElement>('#load-progress');
const selectionOverlay = document.querySelector<HTMLDivElement>('#selection-overlay');
const selectionRect = document.querySelector<HTMLDivElement>('#selection-rect');

const wmtsUrl = (import.meta.env.VITE_IGN_WMTS_URL as string | undefined) ?? 'https://data.geopf.fr/wmts';
const satelliteLayerName =
  (import.meta.env.VITE_IGN_ORTHO_LAYER as string | undefined)
  ?? (import.meta.env.VITE_IGN_WMTS_LAYER as string | undefined)
  ?? 'ORTHOIMAGERY.ORTHOPHOTOS';
const topoLayerName = (import.meta.env.VITE_IGN_TOPO_LAYER as string | undefined) ?? 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2';
const apiUrl = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8000').replace(/\/$/, '');

const DEFAULT_LON = 2.3522;
const DEFAULT_LAT = 48.8566;
const DEFAULT_RANGE = 2500;
const FLAT_TILT = 89;
const OBLIQUE_TILT = 58;
const NETWORK_TIMEOUT_MS = 20_000;
const COPC_METADATA_TIMEOUT_MS = 40_000;
const COPC_LAYER_TIMEOUT_MS = 50_000;
const COPC_RENDER_TIMEOUT_MS = 60_000;

const placement = {
  coord: new itowns.Coordinates('EPSG:4326', DEFAULT_LON, DEFAULT_LAT),
  range: DEFAULT_RANGE,
  tilt: FLAT_TILT,
  heading: 0,
};

// iTowns utilise laz-perf pour décompresser les points LAZ. Le fichier WASM est
// copié dans web/public/laz-perf pendant l'installation et servi localement.
itowns.LASParser.enableLazPerf('/laz-perf');

const mapView = new itowns.GlobeView(mapSurface, placement);
let activeBaseLayerId: string | null = null;
let nativeLidarView: any = null;
let nativeLidarControls: any = null;
let nativeLidarLayer: any = null;
let cameraMode: CameraMode = 'flat';
let baseLayerSequence = 0;
let discoverySequence = 0;
let loadSequence = 0;
let selectedBBox: BBox4326 | null = null;
let selectedTile: SelectedLidarTile | null = null;
let selecting = false;
let draggingSelection = false;
let selectionStart: { x: number; y: number } | null = null;
let cameraTarget = { lon: DEFAULT_LON, lat: DEFAULT_LAT, range: DEFAULT_RANGE };
let loadingLidar = false;
let lidarMode = false;

function setStatus(message: string): void {
  if (statusOutput) statusOutput.textContent = message;
}

function setTileStatus(state: TileState, title: string, detail?: string): void {
  if (!tileStatus) return;
  tileStatus.className = `tile-status ${state}`;
  tileStatus.innerHTML = '';

  const dot = document.createElement('span');
  dot.className = 'state-dot';
  dot.setAttribute('aria-hidden', 'true');

  const content = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  content.appendChild(strong);

  if (detail) {
    const small = document.createElement('span');
    small.textContent = detail;
    content.appendChild(small);
  }
  tileStatus.append(dot, content);
}

function setProgress(downloaded?: number | null, total?: number | null): void {
  if (!loadProgress) return;
  if (downloaded == null) {
    loadProgress.hidden = true;
    loadProgress.value = 0;
    return;
  }
  loadProgress.hidden = false;
  if (total && total > 0) {
    loadProgress.max = total;
    loadProgress.value = Math.min(downloaded, total);
  } else {
    loadProgress.removeAttribute('value');
  }
}

function setViewerMode(mode: 'map' | 'lidar'): void {
  lidarMode = mode === 'lidar';
  mapSurface.hidden = lidarMode;
  lidarSurface.hidden = !lidarMode;
  if (returnMapButton) returnMapButton.hidden = !lidarMode;
  document.querySelectorAll<HTMLElement>('.map-controls').forEach((section) => {
    section.classList.toggle('inactive', lidarMode);
  });
}

function setBusy(busy: boolean): void {
  loadingLidar = busy;
  if (selectRectangleButton) selectRectangleButton.disabled = busy || lidarMode;
  document.querySelectorAll<HTMLInputElement>('input[name="base-mode"], input[name="camera-mode"]').forEach((input) => {
    input.disabled = busy || lidarMode;
  });
  if (displayLidarButton) {
    displayLidarButton.disabled = busy || !selectedTile || lidarMode;
    displayLidarButton.textContent = busy ? 'Ouverture du LiDAR…' : lidarMode ? 'LiDAR affiché' : 'Afficher le LiDAR';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} : délai dépassé`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = NETWORK_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Le service a mis trop de temps à répondre');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchJson<T>(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = NETWORK_TIMEOUT_MS): Promise<T> {
  const response = await fetchWithTimeout(input, init, timeoutMs);
  if (!response.ok) {
    let detail = `Erreur HTTP ${response.status}`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // La réponse distante n'est pas nécessairement du JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

function createWmtsLayer(id: string, layerName: string, format: string): any {
  const source = new itowns.WMTSSource({
    url: wmtsUrl,
    name: layerName,
    tileMatrixSet: 'PM',
    format,
    style: 'normal',
    crs: 'EPSG:3857',
  });
  return new itowns.ColorLayer(id, { source });
}

async function removeActiveBaseLayer(): Promise<void> {
  if (!activeBaseLayerId) return;
  try {
    const existing = mapView.getLayerById(activeBaseLayerId);
    if (existing) await Promise.resolve(mapView.removeLayer(activeBaseLayerId, true));
  } finally {
    activeBaseLayerId = null;
  }
}

async function setBaseMode(mode: BaseMode): Promise<void> {
  const sequence = ++baseLayerSequence;
  const selectedInput = document.querySelector<HTMLInputElement>(`input[name="base-mode"][value="${mode}"]`);
  if (selectedInput) selectedInput.checked = true;
  await removeActiveBaseLayer();
  if (sequence !== baseLayerSequence) return;

  const layerName = mode === 'satellite' ? satelliteLayerName : topoLayerName;
  const format = mode === 'satellite' ? 'image/jpeg' : 'image/png';
  const layerId = `base-${mode}-${sequence}`;
  activeBaseLayerId = layerId;
  await mapView.addLayer(createWmtsLayer(layerId, layerName, format));
  if (sequence !== baseLayerSequence) return;
  mapView.notifyChange();
  setStatus(mode === 'satellite' ? 'Satellite IGN actif.' : 'Plan IGN actif.');
}

function currentTilt(): number {
  return cameraMode === 'flat' ? FLAT_TILT : OBLIQUE_TILT;
}

function applyCamera(lon: number, lat: number, label?: string, range = cameraTarget.range): void {
  cameraTarget = { lon, lat, range };
  void mapView.controls.lookAtCoordinate({
    coord: new itowns.Coordinates('EPSG:4326', lon, lat),
    range,
    tilt: currentTilt(),
    heading: 0,
    time: 650,
  });
  setStatus(label ? `Position atteinte : ${label}` : 'Position atteinte.');
}

function setCameraMode(mode: CameraMode): void {
  cameraMode = mode;
  const input = document.querySelector<HTMLInputElement>(`input[name="camera-mode"][value="${mode}"]`);
  if (input) input.checked = true;
  applyCamera(cameraTarget.lon, cameraTarget.lat, mode === 'flat' ? 'vue 2D verticale' : 'vue 3D légère');
}

function renderSearchResults(features: GeocodeFeature[]): void {
  if (!searchResults) return;
  searchResults.innerHTML = '';
  if (features.length === 0) {
    searchResults.textContent = 'Aucun résultat.';
    return;
  }
  const list = document.createElement('div');
  list.className = 'result-list';
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    const label = feature.properties.label ?? feature.properties.name ?? `${lat}, ${lon}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-item';
    button.textContent = label;
    button.addEventListener('click', () => applyCamera(lon, lat, label, DEFAULT_RANGE));
    list.appendChild(button);
  }
  searchResults.appendChild(list);
}

async function searchAddress(query: string): Promise<void> {
  const value = query.trim();
  if (value.length < 2) {
    renderSearchResults([]);
    setStatus('Saisissez au moins deux caractères.');
    return;
  }
  setStatus('Recherche du lieu…');
  const data = await fetchJson<GeocodeResponse>(`${apiUrl}/geocode/search?q=${encodeURIComponent(value)}&limit=5`);
  const features = data.features ?? [];
  renderSearchResults(features);
  if (features[0]) {
    const [lon, lat] = features[0].geometry.coordinates;
    applyCamera(lon, lat, features[0].properties.label ?? features[0].properties.name, DEFAULT_RANGE);
  } else {
    setStatus('Aucun lieu trouvé.');
  }
}

function screenPointToLonLat(x: number, y: number): { lon: number; lat: number } | null {
  try {
    const picked = new THREE.Vector3();
    mapView.getPickingPositionFromDepth(new THREE.Vector2(x, y), picked);
    if (![picked.x, picked.y, picked.z].every(Number.isFinite)) return null;
    const coordinates = new itowns.Coordinates(mapView.referenceCrs).setFromVector3(picked).as('EPSG:4326');
    if (!Number.isFinite(coordinates.longitude) || !Number.isFinite(coordinates.latitude)) return null;
    return { lon: coordinates.longitude, lat: coordinates.latitude };
  } catch {
    return null;
  }
}

function updateSelectionRect(x0: number, y0: number, x1: number, y1: number): void {
  if (!selectionRect) return;
  selectionRect.style.display = 'block';
  selectionRect.style.left = `${Math.min(x0, x1)}px`;
  selectionRect.style.top = `${Math.min(y0, y1)}px`;
  selectionRect.style.width = `${Math.abs(x1 - x0)}px`;
  selectionRect.style.height = `${Math.abs(y1 - y0)}px`;
}

function setMapControlsEnabled(enabled: boolean): void {
  const controls = mapView.controls as any;
  if (controls?.states) controls.states.enabled = enabled;
  else if (controls) controls.enabled = enabled;
}

function stopSelectionMode(): void {
  selecting = false;
  draggingSelection = false;
  setMapControlsEnabled(true);
  document.body.classList.remove('selection-active');
}

function isCopcUrl(url: string): boolean {
  return url.toLowerCase().includes('.copc.laz');
}

function findDownloadUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^https?:\/\//i.test(trimmed) && /\.laz(\?|#|$)/i.test(trimmed) ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const urls = value.map(findDownloadUrl).filter((url): url is string => Boolean(url));
    return urls.find(isCopcUrl) ?? urls[0] ?? null;
  }
  if (value && typeof value === 'object') {
    const urls = Object.values(value as Record<string, unknown>).map(findDownloadUrl).filter((url): url is string => Boolean(url));
    return urls.find(isCopcUrl) ?? urls[0] ?? null;
  }
  return null;
}

function featureLabel(feature: LidarFeature, index: number): string {
  const properties = feature.properties ?? {};
  for (const key of ['nom', 'name', 'id', 'identifier', 'filename', 'fichier', 'libelle']) {
    const value = properties[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return feature.id ?? `Dalle LiDAR ${index + 1}`;
}

function collectCoordinatePairs(value: unknown, output: Array<[number, number]>): void {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    output.push([value[0], value[1]]);
    return;
  }
  value.forEach((child) => collectCoordinatePairs(child, output));
}

function featureBounds(feature: LidarFeature): Bounds4326 | null {
  const pairs: Array<[number, number]> = [];
  collectCoordinatePairs(feature.geometry?.coordinates, pairs);
  if (pairs.length === 0) return null;
  return pairs.reduce<Bounds4326>((bounds, [lon, lat]) => ({
    minLon: Math.min(bounds.minLon, lon),
    minLat: Math.min(bounds.minLat, lat),
    maxLon: Math.max(bounds.maxLon, lon),
    maxLat: Math.max(bounds.maxLat, lat),
  }), {
    minLon: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  });
}

function chooseTile(features: LidarFeature[], bbox: BBox4326): SelectedLidarTile | null {
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const candidates = features.flatMap((feature, index) => {
    const url = feature.downloadUrl ?? findDownloadUrl(feature.properties);
    const copc = Boolean(feature.isCopc ?? (url ? isCopcUrl(url) : false));
    return url && copc ? [{ label: featureLabel(feature, index), url, bounds: featureBounds(feature) }] : [];
  });
  candidates.sort((left, right) => {
    const score = (candidate: SelectedLidarTile): number => {
      if (!candidate.bounds) return Number.MAX_SAFE_INTEGER;
      const inside = centerLon >= candidate.bounds.minLon && centerLon <= candidate.bounds.maxLon
        && centerLat >= candidate.bounds.minLat && centerLat <= candidate.bounds.maxLat;
      if (inside) return 0;
      const tileLon = (candidate.bounds.minLon + candidate.bounds.maxLon) / 2;
      const tileLat = (candidate.bounds.minLat + candidate.bounds.maxLat) / 2;
      return (tileLon - centerLon) ** 2 + (tileLat - centerLat) ** 2;
    };
    return score(left) - score(right);
  });
  return candidates[0] ?? null;
}

async function discoverLidarForSelection(): Promise<void> {
  if (!selectedBBox) return;
  const sequence = ++discoverySequence;
  selectedTile = null;
  setBusy(false);
  setTileStatus('searching', 'Recherche de la dalle LiDAR…', 'La recherche est automatique.');
  const bbox = `${selectedBBox.minLon},${selectedBBox.minLat},${selectedBBox.maxLon},${selectedBBox.maxLat}`;
  const data = await fetchJson<LidarResponse>(`${apiUrl}/lidar/tiles?bbox=${encodeURIComponent(bbox)}&limit=20`, {}, 30_000);
  if (sequence !== discoverySequence) return;
  const features = data.features ?? [];
  const tile = chooseTile(features, selectedBBox);
  if (tile) {
    selectedTile = tile;
    setTileStatus('ready', 'Dalle LiDAR trouvée', tile.label);
    setStatus('Dalle trouvée. Vous pouvez afficher le LiDAR.');
  } else {
    const hasLaz = features.some((feature) => Boolean(feature.downloadUrl ?? findDownloadUrl(feature.properties)));
    setTileStatus('warning', hasLaz ? 'Dalle non affichable' : 'Aucune dalle trouvée',
      hasLaz ? 'Le fichier disponible n’est pas au format COPC.' : 'Essayez une zone légèrement différente.');
  }
  setBusy(false);
}

function finishSelection(x0: number, y0: number, x1: number, y1: number): void {
  if (Math.abs(x1 - x0) < 12 || Math.abs(y1 - y0) < 12) {
    stopSelectionMode();
    setTileStatus('warning', 'Sélection trop petite', 'Tracez un rectangle un peu plus large.');
    return;
  }
  const first = screenPointToLonLat(x0, y0);
  const second = screenPointToLonLat(x1, y1);
  if (!first || !second) {
    stopSelectionMode();
    setTileStatus('error', 'Sélection impossible', 'Revenez en vue 2D puis réessayez.');
    return;
  }
  selectedBBox = {
    minLon: Math.min(first.lon, second.lon),
    minLat: Math.min(first.lat, second.lat),
    maxLon: Math.max(first.lon, second.lon),
    maxLat: Math.max(first.lat, second.lat),
  };
  stopSelectionMode();
  void discoverLidarForSelection().catch(showDiscoveryError);
}

async function enableRectangleSelection(): Promise<void> {
  if (loadingLidar) return;
  if (lidarMode) await returnToMap();
  discoverySequence += 1;
  selectedBBox = null;
  selectedTile = null;
  setProgress(null);
  if (selectionRect) selectionRect.style.display = 'none';
  selecting = true;
  draggingSelection = false;
  selectionStart = null;
  setMapControlsEnabled(false);
  document.body.classList.add('selection-active');
  setCameraMode('flat');
  setTileStatus('idle', 'Sélection en cours', 'Glissez sur la carte pour définir la zone.');
  setBusy(false);
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return 'taille inconnue';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function probeCopcUrl(url: string): Promise<void> {
  const response = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-374' } }, NETWORK_TIMEOUT_MS);
  if (response.status !== 206) throw new Error(`Lecture partielle indisponible (${response.status})`);
  const bytes = await response.arrayBuffer();
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 4));
  if (signature !== 'LASF') throw new Error('Le fichier reçu n’est pas un fichier LAS/COPC valide');
}

function destroyNativeLidarView(): void {
  loadSequence += 1;
  try {
    nativeLidarView?.dispose?.(true);
  } catch (error) {
    console.warn('Nettoyage de la vue LiDAR incomplet', error);
  }
  nativeLidarView = null;
  nativeLidarControls = null;
  nativeLidarLayer = null;
  lidarSurface.replaceChildren();
}

function focusNativeCopc(view: any, controls: any, layer: any): void {
  const bbox = layer.root?.bbox;
  if (!bbox) throw new Error('Emprise de la dalle indisponible');
  const size = bbox.getSize(new THREE.Vector3());
  const center = bbox.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 10);
  const distance = span * 1.5;
  const camera = view.camera3D;
  camera.up.set(0, 0, 1);
  camera.position.set(center.x + distance * 0.65, center.y - distance * 0.65, center.z + distance * 0.65);
  camera.near = Math.max(span / 10000, 0.1);
  camera.far = span * 20;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.groundLevel = bbox.min.z;
  view.notifyChange(camera);
}

function countRenderedPoints(layer: any): RenderStats {
  let points = 0;
  let nodes = 0;
  const rootObject = layer.group ?? layer.object3d;
  rootObject?.traverse((object: any) => {
    if (!object.isPoints) return;
    nodes += 1;
    points += object.geometry?.getAttribute('position')?.count ?? 0;
  });
  return { points, nodes };
}

async function waitForRenderedPoints(view: any, layer: any, sequence: number): Promise<RenderStats> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < COPC_RENDER_TIMEOUT_MS) {
    if (sequence !== loadSequence) throw new Error('Chargement remplacé par une nouvelle opération');
    const stats = countRenderedPoints(layer);
    if (stats.points > 0) return stats;
    view.notifyChange(view.camera3D);
    await delay(350);
  }
  throw new Error('Le décodeur LiDAR n’a produit aucun point visible');
}

async function openCopcInNativeItowns(url: string, label: string): Promise<RenderStats> {
  const sequence = ++loadSequence;
  setTileStatus('loading', 'Lecture du fichier COPC…', label);
  const source = new itowns.CopcSource({ url, colorDepth: 16 });
  await withTimeout(Promise.resolve(source.whenReady), COPC_METADATA_TIMEOUT_MS, 'Lecture de la dalle');
  if (sequence !== loadSequence) throw new Error('Chargement remplacé');

  destroyNativeLidarView();
  const activeSequence = loadSequence;
  setViewerMode('lidar');
  setBusy(true);

  const referenceCrs = source.crs || 'EPSG:2154';
  const view = new itowns.View(referenceCrs, lidarSurface);
  const controls = new itowns.PlanarControls(view);
  view.controls = controls;
  view.renderer.setClearColor(0x202225);

  const layer = new itowns.CopcLayer('COPC', {
    source,
    crs: view.referenceCrs,
    pointBudget: 2_000_000,
    pointSize: 3,
    sseThreshold: 2,
    mode: itowns.PNTS_MODE.ELEVATION,
  });

  nativeLidarView = view;
  nativeLidarControls = controls;
  nativeLidarLayer = layer;

  await withTimeout(view.addLayer(layer), COPC_LAYER_TIMEOUT_MS, 'Initialisation de la vue iTowns');
  focusNativeCopc(view, controls, layer);
  const stats = await waitForRenderedPoints(view, layer, activeSequence);
  console.info('[iTowns COPC]', { label, crs: referenceCrs, ...stats });
  return stats;
}

async function pollDownloadJob(jobId: string): Promise<DownloadJob> {
  while (true) {
    const job = await fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads/${jobId}`);
    setProgress(job.bytesDownloaded ?? 0, job.totalBytes);
    const detail = job.totalBytes
      ? `${formatBytes(job.bytesDownloaded)} sur ${formatBytes(job.totalBytes)}`
      : `${formatBytes(job.bytesDownloaded)} téléchargés`;
    setTileStatus('loading', 'Téléchargement de la dalle…', detail);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error ?? 'Téléchargement de la dalle impossible');
    if (job.status === 'cancelled') throw new Error('Téléchargement annulé');
    await delay(700);
  }
}

async function downloadAndDisplaySelectedTile(): Promise<void> {
  if (!selectedTile) return;
  const tile = selectedTile;
  setBusy(true);
  setTileStatus('loading', 'Préparation de la dalle LiDAR…', tile.label);
  try {
    const initial = await fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tile.url }),
    });
    const job = await pollDownloadJob(initial.id);
    if (!job.path) throw new Error('Le serveur n’a pas fourni le fichier LiDAR');
    const localUrl = `${apiUrl}${job.path}`;
    await probeCopcUrl(localUrl);
    setTileStatus('loading', 'Ouverture dans iTowns…', 'Décompression locale des points LAZ.');
    const stats = await openCopcInNativeItowns(localUrl, tile.label);
    setProgress(null);
    setTileStatus('success', 'LiDAR affiché', `${stats.points.toLocaleString('fr-FR')} points visibles`);
    setStatus('Le LiDAR est affiché par la vue COPC native d’iTowns.');
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

async function returnToMap(): Promise<void> {
  destroyNativeLidarView();
  setViewerMode('map');
  if (selectedTile) setTileStatus('ready', 'Dalle LiDAR trouvée', selectedTile.label);
  else setTileStatus('idle', 'Aucune zone sélectionnée', 'Sélectionnez une petite zone sur la carte.');
  setBusy(false);
  mapView.notifyChange();
  setStatus('Carte IGN active.');
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/délai|temps/i.test(message)) return 'Le chargement a pris trop de temps. Réessayez.';
  if (/décodeur|aucun point/i.test(message)) return 'Le fichier est ouvert, mais le décodeur LAZ n’a produit aucun point.';
  if (/partielle|206/i.test(message)) return 'Le fichier LiDAR ne peut pas être lu correctement.';
  if (/wasm|webassembly/i.test(message)) return 'Le décodeur LiDAR local n’a pas pu démarrer.';
  return message;
}

function showDiscoveryError(error: unknown): void {
  console.error(error);
  selectedTile = null;
  const message = friendlyError(error);
  setTileStatus('error', 'Recherche de dalle impossible', message);
  setStatus(`Erreur LiDAR : ${message}`);
  setBusy(false);
}

function showLoadError(error: unknown): void {
  console.error(error);
  const message = friendlyError(error);
  setProgress(null);
  setTileStatus('error', 'Impossible d’afficher le LiDAR', message);
  setStatus(`Erreur LiDAR : ${message}`);
  setBusy(false);
}

function overlayEventPosition(event: PointerEvent): { x: number; y: number } {
  const rect = mapSurface.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

selectionOverlay?.addEventListener('pointerdown', (event) => {
  if (!selecting) return;
  event.preventDefault();
  selectionOverlay.setPointerCapture(event.pointerId);
  selectionStart = overlayEventPosition(event);
  draggingSelection = true;
  updateSelectionRect(selectionStart.x, selectionStart.y, selectionStart.x, selectionStart.y);
}, { capture: true });

selectionOverlay?.addEventListener('pointermove', (event) => {
  if (!draggingSelection || !selectionStart) return;
  event.preventDefault();
  const current = overlayEventPosition(event);
  updateSelectionRect(selectionStart.x, selectionStart.y, current.x, current.y);
}, { capture: true });

selectionOverlay?.addEventListener('pointerup', (event) => {
  if (!draggingSelection || !selectionStart) return;
  event.preventDefault();
  const end = overlayEventPosition(event);
  finishSelection(selectionStart.x, selectionStart.y, end.x, end.y);
  selectionStart = null;
}, { capture: true });

selectionOverlay?.addEventListener('pointercancel', () => {
  stopSelectionMode();
  setTileStatus('idle', 'Sélection annulée', 'Cliquez sur Sélectionner une zone pour recommencer.');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selecting) {
    stopSelectionMode();
    if (selectionRect) selectionRect.style.display = 'none';
  }
});

window.addEventListener('error', (event) => {
  console.error(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Promesse non gérée]', event.reason);
});

void setBaseMode('topo').then(() => setCameraMode('flat')).catch(showLoadError);

document.querySelector<HTMLFormElement>('#address-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = document.querySelector<HTMLInputElement>('#address')?.value ?? '';
  void searchAddress(query).catch((error: unknown) => {
    setStatus(`Erreur recherche : ${friendlyError(error)}`);
  });
});

document.querySelector<HTMLButtonElement>('#reset-flat')?.addEventListener('click', () => setCameraMode('flat'));
selectRectangleButton?.addEventListener('click', () => void enableRectangleSelection().catch(showLoadError));
displayLidarButton?.addEventListener('click', () => void downloadAndDisplaySelectedTile().catch(showLoadError));
returnMapButton?.addEventListener('click', () => void returnToMap().catch(showLoadError));

document.querySelectorAll<HTMLInputElement>('input[name="base-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked && !lidarMode) void setBaseMode(input.value as BaseMode).catch(showLoadError);
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="camera-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked && !lidarMode) setCameraMode(input.value as CameraMode);
  });
});
