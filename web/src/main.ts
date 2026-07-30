import * as THREE from 'three';
import * as itowns from 'itowns';
import './style.css';

type BaseMode = 'topo' | 'satellite';
type CameraMode = 'flat' | 'oblique';
type TileState = 'idle' | 'searching' | 'ready' | 'loading' | 'success' | 'warning' | 'error';
type ProcessProfile = 'fluid' | 'balanced' | 'detailed';
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

type ProcessJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  phase?: string;
  path?: string | null;
  buildingsPath?: string | null;
  buildingCount?: number;
  pointBudgetHint?: number;
  error?: string | null;
};

type SelectedLidarTile = {
  label: string;
  url: string;
  bounds: Bounds4326 | null;
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Élément #app introuvable');

app.innerHTML = `
  <aside class="panel">
    <h1>Simulateur LiDAR France</h1>
    <p>Carte IGN, sélection LiDAR et génération simplifiée depuis le nuage de points.</p>

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
      <p class="hint">Sélectionnez une zone. La dalle sera téléchargée puis cropée/nettoyée par PDAL.</p>
      <button id="select-rectangle" type="button">Sélectionner une zone</button>

      <label class="control-row compact-process-profile" for="process-profile">
        <span>Profil simulateur</span>
        <select id="process-profile">
          <option value="fluid">Fluide</option>
          <option value="balanced" selected>Équilibré</option>
          <option value="detailed">Détaillé</option>
        </select>
      </label>

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

const mapSurface = requireElement<HTMLDivElement>('#map-surface');
const lidarSurface = requireElement<HTMLDivElement>('#lidar-surface');
const statusOutput = requireElement<HTMLDivElement>('#status');
const searchResults = requireElement<HTMLDivElement>('#search-results');
const tileStatus = requireElement<HTMLDivElement>('#tile-status');
const selectRectangleButton = requireElement<HTMLButtonElement>('#select-rectangle');
const displayLidarButton = requireElement<HTMLButtonElement>('#display-lidar');
const returnMapButton = requireElement<HTMLButtonElement>('#return-map');
const loadProgress = requireElement<HTMLProgressElement>('#load-progress');
const selectionOverlay = requireElement<HTMLDivElement>('#selection-overlay');
const selectionRect = requireElement<HTMLDivElement>('#selection-rect');
const profileSelect = requireElement<HTMLSelectElement>('#process-profile');

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

const placement = {
  coord: new itowns.Coordinates('EPSG:4326', DEFAULT_LON, DEFAULT_LAT),
  range: DEFAULT_RANGE,
  tilt: FLAT_TILT,
  heading: 0,
};

itowns.LASParser.enableLazPerf('/laz-perf');

const mapView = new itowns.GlobeView(mapSurface, placement);
let activeBaseLayerId: string | null = null;
let cameraMode: CameraMode = 'flat';
let baseLayerSequence = 0;
let discoverySequence = 0;
let selectedBBox: BBox4326 | null = null;
let selectedTile: SelectedLidarTile | null = null;
let selecting = false;
let draggingSelection = false;
let selectionStart: { x: number; y: number } | null = null;
let cameraTarget = { lon: DEFAULT_LON, lat: DEFAULT_LAT, range: DEFAULT_RANGE };
let loadingLidar = false;
let lidarMode = false;

function setStatus(message: string): void {
  statusOutput.textContent = message;
}

function setTileStatus(state: TileState, title: string, detail?: string): void {
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
  returnMapButton.hidden = !lidarMode;
  document.querySelectorAll<HTMLElement>('.map-controls').forEach((section) => {
    section.classList.toggle('inactive', lidarMode);
  });
}

function setBusy(busy: boolean): void {
  loadingLidar = busy;
  selectRectangleButton.disabled = busy || lidarMode;
  profileSelect.disabled = busy || lidarMode;
  document.querySelectorAll<HTMLInputElement>('input[name="base-mode"], input[name="camera-mode"]').forEach((input) => {
    input.disabled = busy || lidarMode;
  });
  displayLidarButton.disabled = busy || !selectedTile || !selectedBBox || lidarMode;
  displayLidarButton.textContent = busy ? 'Préparation LiDAR…' : lidarMode ? 'LiDAR affiché' : 'Afficher le LiDAR';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
    setStatus('Dalle trouvée. Le prochain affichage utilisera un crop PDAL de la sélection.');
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
  selectionRect.style.display = 'none';
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

function processPhaseLabel(phase?: string): string {
  if (phase === 'crop-clean') return 'Crop et nettoyage PDAL…';
  if (phase === 'building-detection') return 'Génération des volumes bâtiment LiDAR…';
  if (phase === 'cached') return 'Zone traitée déjà disponible.';
  return 'Préparation PDAL de la sélection…';
}

async function pollProcessJob(jobId: string): Promise<ProcessJob> {
  while (true) {
    const job = await fetchJson<ProcessJob>(`${apiUrl}/lidar/processes/${jobId}`, {}, 30_000);
    setTileStatus('loading', processPhaseLabel(job.phase), job.buildingCount ? `${job.buildingCount} volume(s) LiDAR détecté(s)` : undefined);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error ?? 'Traitement PDAL impossible');
    await delay(1000);
  }
}

async function processSelectedLidar(localPath: string, bbox: BBox4326, profile: ProcessProfile): Promise<ProcessJob> {
  setTileStatus('loading', 'Préparation PDAL de la sélection…', 'La dalle brute est cropée avant affichage.');
  const initial = await fetchJson<ProcessJob>(`${apiUrl}/lidar/processes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: localPath, bbox, profile }),
  }, 30_000);
  if (initial.status === 'completed') return initial;
  return pollProcessJob(initial.id);
}

async function openProcessedCopc(processedUrl: string, label: string, buildingsUrl?: string | null): Promise<void> {
  await probeCopcUrl(processedUrl);
  setTileStatus('loading', 'Ouverture dans iTowns…', 'La visionneuse recevra la zone cropée et les volumes LiDAR.');
  const source = new itowns.CopcSource({ url: processedUrl, colorDepth: 16 });
  await source.whenReady;
  const layer = new itowns.CopcLayer(label, {
    source,
    crs: source.crs || 'EPSG:2154',
    pointBudget: Number(profileSelect.value === 'detailed' ? 3_500_000 : profileSelect.value === 'fluid' ? 750_000 : 1_800_000),
    pointSize: 2,
    sseThreshold: 1.2,
    mode: itowns.PNTS_MODE.CLASSIFICATION,
  });
  (layer as any).simulationBuildingsUrl = buildingsUrl ?? undefined;
  await mapView.addLayer(layer as any);
}

async function downloadAndDisplaySelectedTile(): Promise<void> {
  if (!selectedTile || !selectedBBox) return;
  const tile = selectedTile;
  const bbox = selectedBBox;
  const profile = profileSelect.value as ProcessProfile;
  setBusy(true);
  setTileStatus('loading', 'Préparation de la dalle LiDAR…', tile.label);
  try {
    const initial = await fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tile.url }),
    });
    const download = await pollDownloadJob(initial.id);
    if (!download.path) throw new Error('Le serveur n’a pas fourni le fichier LiDAR');
    const processed = await processSelectedLidar(download.path, bbox, profile);
    if (!processed.path) throw new Error('Le serveur n’a pas fourni la zone LiDAR traitée');
    const processedUrl = `${apiUrl}${processed.path}`;
    const buildingsUrl = processed.buildingsPath ? `${apiUrl}${processed.buildingsPath}` : undefined;
    setProgress(null);
    setTileStatus('success', 'Zone LiDAR traitée', `${processed.buildingCount ?? 0} volume(s) bâtiment LiDAR`);
    await openProcessedCopc(processedUrl, `Sélection LiDAR ${profile}`, buildingsUrl);
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

async function returnToMap(): Promise<void> {
  setViewerMode('map');
  if (selectedTile) setTileStatus('ready', 'Dalle LiDAR trouvée', selectedTile.label);
  else setTileStatus('idle', 'Aucune zone sélectionnée', 'Sélectionnez une petite zone sur la carte.');
  setBusy(false);
  mapView.notifyChange();
  setStatus('Carte IGN active.');
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/PDAL.*introuvable|pdal est introuvable/i.test(message)) return 'PDAL est introuvable. Installez PDAL pour activer le crop/nettoyage LiDAR.';
  if (/délai|temps/i.test(message)) return 'Le traitement a pris trop de temps. Réessayez avec une zone plus petite ou le profil Fluide.';
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

selectionOverlay.addEventListener('pointerdown', (event) => {
  if (!selecting) return;
  event.preventDefault();
  selectionOverlay.setPointerCapture(event.pointerId);
  selectionStart = overlayEventPosition(event);
  draggingSelection = true;
  updateSelectionRect(selectionStart.x, selectionStart.y, selectionStart.x, selectionStart.y);
}, { capture: true });

selectionOverlay.addEventListener('pointermove', (event) => {
  if (!draggingSelection || !selectionStart) return;
  event.preventDefault();
  const current = overlayEventPosition(event);
  updateSelectionRect(selectionStart.x, selectionStart.y, current.x, current.y);
}, { capture: true });

selectionOverlay.addEventListener('pointerup', (event) => {
  if (!draggingSelection || !selectionStart) return;
  event.preventDefault();
  const end = overlayEventPosition(event);
  finishSelection(selectionStart.x, selectionStart.y, end.x, end.y);
  selectionStart = null;
}, { capture: true });

selectionOverlay.addEventListener('pointercancel', () => {
  stopSelectionMode();
  setTileStatus('idle', 'Sélection annulée', 'Cliquez sur Sélectionner une zone pour recommencer.');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selecting) {
    stopSelectionMode();
    selectionRect.style.display = 'none';
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
selectRectangleButton.addEventListener('click', () => void enableRectangleSelection().catch(showLoadError));
displayLidarButton.addEventListener('click', () => void downloadAndDisplaySelectedTile().catch(showLoadError));
returnMapButton.addEventListener('click', () => void returnToMap().catch(showLoadError));

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
