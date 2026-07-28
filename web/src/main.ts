import * as THREE from 'three';
import * as itowns from 'itowns';
import './style.css';

type BaseMode = 'topo' | 'satellite' | 'itowns';
type CameraMode = 'flat' | 'oblique';
type TileState = 'idle' | 'searching' | 'ready' | 'loading' | 'success' | 'warning' | 'error';
type BBox4326 = { minLon: number; minLat: number; maxLon: number; maxLat: number };
type Bounds4326 = { minLon: number; minLat: number; maxLon: number; maxLat: number };

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
    <p>Carte IGN et nuages de points LiDAR dans iTowns.</p>

    <form id="address-form" class="block compact-block">
      <label for="address">Rechercher un lieu</label>
      <div class="row">
        <input id="address" type="search" placeholder="Ex. Cléden-Cap-Sizun" autocomplete="street-address">
        <button type="submit">Rechercher</button>
      </div>
      <div id="search-results" class="results" aria-live="polite"></div>
    </form>

    <section class="block compact-block">
      <h2>Fond de carte</h2>
      <label><input name="base-mode" type="radio" value="topo" checked> BD topo / Plan IGN</label>
      <label><input name="base-mode" type="radio" value="satellite"> Satellite IGN</label>
    </section>

    <section class="block compact-block">
      <h2>Angle</h2>
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
      <button id="clear-lidar" type="button" hidden>Retirer le LiDAR</button>
    </section>

    <div id="status">Initialisation…</div>
  </aside>

  <main id="viewer">
    <div id="selection-overlay" aria-hidden="true">
      <div id="selection-rect"></div>
      <div id="selection-instruction">Glissez pour sélectionner une zone LiDAR</div>
    </div>
  </main>
`;

const viewerDiv = document.querySelector<HTMLDivElement>('#viewer');
if (!viewerDiv) throw new Error('Élément #viewer introuvable');

const statusOutput = document.querySelector<HTMLDivElement>('#status');
const searchResults = document.querySelector<HTMLDivElement>('#search-results');
const tileStatus = document.querySelector<HTMLDivElement>('#tile-status');
const selectRectangleButton = document.querySelector<HTMLButtonElement>('#select-rectangle');
const displayLidarButton = document.querySelector<HTMLButtonElement>('#display-lidar');
const clearLidarButton = document.querySelector<HTMLButtonElement>('#clear-lidar');
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
const COPC_METADATA_TIMEOUT_MS = 35_000;
const COPC_LAYER_TIMEOUT_MS = 45_000;
const COPC_RENDER_TIMEOUT_MS = 45_000;

const placement = {
  coord: new itowns.Coordinates('EPSG:4326', DEFAULT_LON, DEFAULT_LAT),
  range: DEFAULT_RANGE,
  tilt: FLAT_TILT,
  heading: 0,
};

const view = new itowns.GlobeView(viewerDiv, placement);
let activeLayerId: string | null = null;
let activeCopcLayerId: string | null = null;
let cameraMode: CameraMode = 'flat';
let layerSwitchSequence = 0;
let discoverySequence = 0;
let loadSequence = 0;
let selectedBBox: BBox4326 | null = null;
let selectedTile: SelectedLidarTile | null = null;
let selecting = false;
let draggingSelection = false;
let selectionStart: { x: number; y: number } | null = null;
let cameraTarget = { lon: DEFAULT_LON, lat: DEFAULT_LAT, range: DEFAULT_RANGE };
let loadingLidar = false;

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

function setBusy(busy: boolean): void {
  loadingLidar = busy;
  if (selectRectangleButton) selectRectangleButton.disabled = busy;
  document.querySelectorAll<HTMLInputElement>('input[name="base-mode"], input[name="camera-mode"]').forEach((input) => {
    input.disabled = busy;
  });

  if (displayLidarButton) {
    displayLidarButton.disabled = busy || !selectedTile || Boolean(activeCopcLayerId);
    displayLidarButton.textContent = busy ? 'Chargement du LiDAR…' : activeCopcLayerId ? 'LiDAR affiché' : 'Afficher le LiDAR';
  }
}

function notifyView(changeSource?: unknown): void {
  view.notifyChange(changeSource as never);
}

function currentTilt(): number {
  return cameraMode === 'flat' ? FLAT_TILT : OBLIQUE_TILT;
}

function setRadioValue(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
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
      // Une réponse distante n'est pas toujours en JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

function createWmtsLayer(id: string, layerName: string, format: string): unknown {
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

function layerConfig(mode: BaseMode): { label: string; layerName: string; format: string } {
  if (mode === 'satellite') return { label: 'Satellite IGN', layerName: satelliteLayerName, format: 'image/jpeg' };
  return { label: mode === 'itowns' ? 'Vue LiDAR iTowns' : 'BD topo / Plan IGN', layerName: topoLayerName, format: 'image/png' };
}

async function removeActiveBaseLayer(): Promise<void> {
  if (!activeLayerId) return;
  try {
    const existing = view.getLayerById(activeLayerId);
    if (existing) await Promise.resolve(view.removeLayer(activeLayerId, true));
  } catch (error) {
    console.warn('Suppression du fond de carte impossible', error);
  } finally {
    activeLayerId = null;
  }
}

async function setBaseMode(mode: BaseMode): Promise<void> {
  const switchId = ++layerSwitchSequence;
  if (mode !== 'itowns') setRadioValue('base-mode', mode);
  await removeActiveBaseLayer();
  if (switchId !== layerSwitchSequence) return;

  const config = layerConfig(mode);
  const layerId = `base-${mode}-${switchId}`;
  activeLayerId = layerId;
  await view.addLayer(createWmtsLayer(layerId, config.layerName, config.format) as never);
  if (switchId !== layerSwitchSequence) return;

  setStatus(mode === 'itowns' ? 'Vue LiDAR iTowns active.' : `${config.label} actif.`);
  notifyView();
}

function applyCamera(lon: number, lat: number, label?: string, range = cameraTarget.range): void {
  cameraTarget = { lon, lat, range };
  if (!view.controls) {
    setStatus('Contrôles caméra indisponibles.');
    return;
  }

  void view.controls.lookAtCoordinate({
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
  setRadioValue('camera-mode', mode);
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
    const label = features[0].properties.label ?? features[0].properties.name;
    applyCamera(lon, lat, label, DEFAULT_RANGE);
  } else {
    setStatus('Aucun lieu trouvé.');
  }
}

function screenPointToLonLat(x: number, y: number): { lon: number; lat: number } | null {
  try {
    const picked = new THREE.Vector3();
    view.getPickingPositionFromDepth(new THREE.Vector2(x, y), picked);
    if (![picked.x, picked.y, picked.z].every(Number.isFinite)) return null;

    const coordinates = new itowns.Coordinates(view.referenceCrs).setFromVector3(picked).as('EPSG:4326');
    if (!Number.isFinite(coordinates.longitude) || !Number.isFinite(coordinates.latitude)) return null;
    return { lon: coordinates.longitude, lat: coordinates.latitude };
  } catch (error) {
    console.warn('Conversion écran vers coordonnées impossible', error);
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

function setControlsEnabled(enabled: boolean): void {
  const controls = view.controls as unknown as { states?: { enabled: boolean }; enabled?: boolean };
  if (controls?.states) controls.states.enabled = enabled;
  else if (controls && 'enabled' in controls) controls.enabled = enabled;
}

function stopSelectionMode(): void {
  selecting = false;
  draggingSelection = false;
  setControlsEnabled(true);
  document.body.classList.remove('selection-active');
}

function isCopcUrl(url: string): boolean {
  return url.trim().toLowerCase().includes('.copc.laz');
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
    if (!url || !copc) return [];
    return [{ label: featureLabel(feature, index), url, bounds: featureBounds(feature) }];
  });

  candidates.sort((left, right) => {
    const score = (candidate: SelectedLidarTile): number => {
      if (!candidate.bounds) return Number.MAX_SAFE_INTEGER;
      const inside = centerLon >= candidate.bounds.minLon
        && centerLon <= candidate.bounds.maxLon
        && centerLat >= candidate.bounds.minLat
        && centerLat <= candidate.bounds.maxLat;
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
  setStatus('Recherche de la dalle LiDAR IGN…');

  const bbox = `${selectedBBox.minLon},${selectedBBox.minLat},${selectedBBox.maxLon},${selectedBBox.maxLat}`;
  const data = await fetchJson<LidarResponse>(`${apiUrl}/lidar/tiles?bbox=${encodeURIComponent(bbox)}&limit=20`, {}, 30_000);
  if (sequence !== discoverySequence) return;

  const features = data.features ?? [];
  const tile = chooseTile(features, selectedBBox);
  if (tile) {
    selectedTile = tile;
    setTileStatus('ready', 'Dalle LiDAR trouvée', tile.label);
    setStatus('Dalle trouvée. Vous pouvez afficher le LiDAR.');
    setBusy(false);
    return;
  }

  const hasLaz = features.some((feature) => Boolean(feature.downloadUrl ?? findDownloadUrl(feature.properties)));
  setTileStatus(
    'warning',
    hasLaz ? 'Dalle trouvée, mais non affichable' : 'Aucune dalle LiDAR trouvée',
    hasLaz ? 'La dalle disponible n’est pas encore au format COPC.' : 'Essayez une zone légèrement différente.',
  );
  setStatus('Aucune dalle COPC affichable pour cette sélection.');
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
  discoverySequence += 1;
  selectedBBox = null;
  selectedTile = null;
  setProgress(null);

  if (activeCopcLayerId) {
    await removeCurrentLidarLayer();
    if (clearLidarButton) clearLidarButton.hidden = true;
    await setBaseMode('topo');
  }

  if (selectionRect) selectionRect.style.display = 'none';
  selecting = true;
  draggingSelection = false;
  selectionStart = null;
  setControlsEnabled(false);
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

async function removeCurrentLidarLayer(): Promise<void> {
  if (!activeCopcLayerId) return;
  const layerId = activeCopcLayerId;
  activeCopcLayerId = null;
  const existing = view.getLayerById(layerId);
  if (existing) await Promise.resolve(view.removeLayer(layerId, true));
  notifyView();
}

async function probeCopcUrl(url: string): Promise<void> {
  console.info('[COPC] Vérification Range', url);
  const response = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-374' } }, NETWORK_TIMEOUT_MS);
  if (response.status !== 206) throw new Error(`Lecture partielle indisponible (${response.status})`);

  const bytes = await response.arrayBuffer();
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 4));
  if (signature !== 'LASF') throw new Error('Le fichier reçu n’est pas un fichier LAS/COPC valide');
}

async function centerOnCopcSource(source: unknown): Promise<void> {
  const typedSource = source as {
    extent?: { as?: (crs: string) => { center: (target: unknown) => any } };
    info?: { cube?: number[] };
  };
  const extent = typedSource.extent?.as?.('EPSG:4326');
  if (!extent) throw new Error('Emprise COPC indisponible');

  const center = extent.center(new itowns.Coordinates('EPSG:4326'));
  const cube = typedSource.info?.cube;
  const width = cube && cube.length >= 6 ? Math.abs(cube[3] - cube[0]) : 500;
  const height = cube && cube.length >= 6 ? Math.abs(cube[4] - cube[1]) : 500;
  const range = Math.max(width, height, 250) * 2.4;

  cameraTarget = { lon: center.longitude, lat: center.latitude, range };
  cameraMode = 'oblique';
  setRadioValue('camera-mode', 'oblique');
  if (!view.controls) throw new Error('Contrôles caméra indisponibles');

  await view.controls.lookAtCoordinate({
    coord: center,
    range,
    tilt: OBLIQUE_TILT,
    heading: 0,
    time: 900,
  });
  notifyView();
}

function countRenderedPoints(layer: unknown): RenderStats {
  const group = (layer as { group?: THREE.Object3D }).group;
  let points = 0;
  let nodes = 0;
  group?.traverse((object) => {
    const candidate = object as THREE.Points;
    if (!candidate.isPoints) return;
    nodes += 1;
    points += candidate.geometry?.getAttribute('position')?.count ?? 0;
  });
  return { points, nodes };
}

async function waitForRenderedPoints(layer: unknown, sequence: number): Promise<RenderStats> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < COPC_RENDER_TIMEOUT_MS) {
    if (sequence !== loadSequence) throw new Error('Chargement remplacé par une nouvelle opération');
    const stats = countRenderedPoints(layer);
    if (stats.points > 0) return stats;
    notifyView(layer);
    await delay(500);
  }
  throw new Error('Le fichier est chargé, mais aucun point n’est visible');
}

async function addCopcLayer(url: string, label: string, alreadyProbed = false): Promise<RenderStats> {
  const cleanUrl = url.trim();
  if (!isCopcUrl(cleanUrl)) throw new Error('La dalle sélectionnée n’est pas au format COPC');

  const sequence = ++loadSequence;
  if (!alreadyProbed) await probeCopcUrl(cleanUrl);
  if (sequence !== loadSequence) throw new Error('Chargement remplacé');

  await removeCurrentLidarLayer();
  await setBaseMode('itowns');
  if (sequence !== loadSequence) throw new Error('Chargement remplacé');

  setTileStatus('loading', 'Ouverture de la dalle LiDAR…', label);
  const source = new itowns.CopcSource({ url: cleanUrl, colorDepth: 16 });
  await withTimeout(
    Promise.resolve((source as unknown as { whenReady: Promise<unknown> }).whenReady),
    COPC_METADATA_TIMEOUT_MS,
    'Lecture de la dalle',
  );

  const layerId = `lidar-copc-${Date.now()}`;
  const layer = new itowns.CopcLayer(layerId, {
    source,
    crs: view.referenceCrs,
    pointBudget: 1_000_000,
    pointSize: 4,
    sseThreshold: 2,
    mode: itowns.PNTS_MODE.ELEVATION,
  });
  activeCopcLayerId = layerId;

  try {
    await withTimeout(
      (itowns.View.prototype.addLayer as unknown as (this: typeof view, value: unknown) => Promise<unknown>).call(view, layer),
      COPC_LAYER_TIMEOUT_MS,
      'Initialisation du LiDAR',
    );
  } catch (error) {
    const existing = view.getLayerById(layerId);
    if (existing) await Promise.resolve(view.removeLayer(layerId, true));
    activeCopcLayerId = null;
    throw error;
  }

  await centerOnCopcSource(source);
  const stats = await waitForRenderedPoints(layer, sequence);
  console.info('[COPC] LiDAR visible', { label, ...stats });
  return stats;
}

async function pollDownloadJob(jobId: string): Promise<DownloadJob> {
  while (true) {
    const job = await fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads/${jobId}`);
    setProgress(job.bytesDownloaded ?? 0, job.totalBytes);

    const detail = job.totalBytes
      ? `${formatBytes(job.bytesDownloaded)} sur ${formatBytes(job.totalBytes)}`
      : `${formatBytes(job.bytesDownloaded)} téléchargés`;
    setTileStatus('loading', 'Préparation de la dalle LiDAR…', detail);

    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error ?? 'Téléchargement de la dalle impossible');
    if (job.status === 'cancelled') throw new Error('Téléchargement annulé');
    await delay(700);
  }
}

async function downloadAndLoadSelectedTile(): Promise<void> {
  if (!selectedTile) return;
  const tile = selectedTile;
  setBusy(true);
  setTileStatus('loading', 'Préparation de la dalle LiDAR…', tile.label);
  setStatus('Préparation du LiDAR…');

  try {
    const initial = await fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tile.url }),
    });
    const job = await pollDownloadJob(initial.id);
    if (!job.path) throw new Error('Le serveur n’a pas fourni le fichier LiDAR');

    const localUrl = `${apiUrl}${job.path}`;
    setTileStatus('loading', 'Affichage du LiDAR dans iTowns…', tile.label);
    await probeCopcUrl(localUrl);
    const stats = await addCopcLayer(localUrl, tile.label, true);

    setProgress(null);
    setTileStatus('success', 'LiDAR affiché', `${tile.label} · ${stats.points.toLocaleString('fr-FR')} points visibles`);
    setStatus('Le LiDAR est affiché dans iTowns.');
    if (clearLidarButton) clearLidarButton.hidden = false;
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

async function clearLidarLayer(): Promise<void> {
  loadSequence += 1;
  await removeCurrentLidarLayer();
  if (clearLidarButton) clearLidarButton.hidden = true;
  await setBaseMode('topo');

  if (selectedTile) {
    setTileStatus('ready', 'Dalle LiDAR trouvée', selectedTile.label);
  } else {
    setTileStatus('idle', 'Aucune zone sélectionnée', 'Sélectionnez une petite zone sur la carte.');
  }
  setBusy(false);
  setStatus('LiDAR retiré.');
}

async function switchToBaseMode(mode: Exclude<BaseMode, 'itowns'>): Promise<void> {
  if (activeCopcLayerId) {
    await removeCurrentLidarLayer();
    if (clearLidarButton) clearLidarButton.hidden = true;
  }
  await setBaseMode(mode);
  if (selectedTile) setTileStatus('ready', 'Dalle LiDAR trouvée', selectedTile.label);
  setBusy(false);
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/délai|temps/i.test(message)) return 'Le chargement a pris trop de temps. Réessayez.';
  if (/aucun point/i.test(message)) return 'La dalle est ouverte, mais aucun point n’est visible.';
  if (/partielle|206/i.test(message)) return 'Le fichier LiDAR ne peut pas être lu correctement.';
  return message;
}

function showDiscoveryError(error: unknown): void {
  console.error(error);
  const message = friendlyError(error);
  selectedTile = null;
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
  if (activeCopcLayerId && clearLidarButton) clearLidarButton.hidden = false;
  setBusy(false);
}

function overlayEventPosition(event: PointerEvent): { x: number; y: number } {
  const rect = viewerDiv.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

selectionOverlay?.addEventListener('pointerdown', (event) => {
  if (!selecting) return;
  event.preventDefault();
  event.stopPropagation();
  selectionOverlay.setPointerCapture(event.pointerId);
  selectionStart = overlayEventPosition(event);
  draggingSelection = true;
  updateSelectionRect(selectionStart.x, selectionStart.y, selectionStart.x, selectionStart.y);
}, { capture: true });

selectionOverlay?.addEventListener('pointermove', (event) => {
  if (!draggingSelection || !selectionStart) return;
  event.preventDefault();
  event.stopPropagation();
  const current = overlayEventPosition(event);
  updateSelectionRect(selectionStart.x, selectionStart.y, current.x, current.y);
}, { capture: true });

selectionOverlay?.addEventListener('pointerup', (event) => {
  if (!draggingSelection || !selectionStart) return;
  event.preventDefault();
  event.stopPropagation();
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
    setTileStatus('idle', 'Sélection annulée', 'Cliquez sur Sélectionner une zone pour recommencer.');
  }
});

window.addEventListener('error', (event) => {
  console.error(event.error ?? event.message);
  setStatus(`Erreur carte : ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
});

void setBaseMode('topo').then(() => setCameraMode('flat')).catch((error: unknown) => {
  console.error(error);
  setStatus(`Erreur fond de carte : ${String(error)}`);
});

document.querySelector<HTMLFormElement>('#address-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = document.querySelector<HTMLInputElement>('#address')?.value ?? '';
  void searchAddress(query).catch((error: unknown) => {
    console.error(error);
    setStatus(`Erreur recherche : ${friendlyError(error)}`);
  });
});

document.querySelector<HTMLButtonElement>('#reset-flat')?.addEventListener('click', () => setCameraMode('flat'));
selectRectangleButton?.addEventListener('click', () => void enableRectangleSelection().catch(showLoadError));
displayLidarButton?.addEventListener('click', () => void downloadAndLoadSelectedTile().catch(showLoadError));
clearLidarButton?.addEventListener('click', () => void clearLidarLayer().catch(showLoadError));

document.querySelectorAll<HTMLInputElement>('input[name="base-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) void switchToBaseMode(input.value as Exclude<BaseMode, 'itowns'>).catch(showLoadError);
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="camera-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setCameraMode(input.value as CameraMode);
  });
});
