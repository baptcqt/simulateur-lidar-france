import * as THREE from 'three';
import * as itowns from 'itowns';
import './style.css';

type BaseMode = 'topo' | 'satellite' | 'itowns';
type CameraMode = 'flat' | 'oblique';
type StepState = 'pending' | 'running' | 'success' | 'error';
type BBox4326 = { minLon: number; minLat: number; maxLon: number; maxLat: number };

type GeocodeFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { label?: string; name?: string; city?: string; postcode?: string; score?: number };
};

type GeocodeResponse = { type: 'FeatureCollection'; features?: GeocodeFeature[] };

type LidarFeature = {
  id?: string;
  properties?: Record<string, unknown>;
  downloadUrl?: string | null;
  isCopc?: boolean;
};

type LidarResponse = { features?: LidarFeature[] };

type DownloadJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase?: string;
  filename?: string;
  path?: string | null;
  bytesDownloaded?: number;
  totalBytes?: number | null;
  error?: string | null;
};

type RenderStats = { points: number; nodes: number };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Élément #app introuvable');

app.innerHTML = `
  <aside class="panel">
    <h1>Simulateur LiDAR France</h1>
    <p>Visualisation IGN avec moteur iTowns.</p>

    <form id="address-form" class="block compact-block">
      <label for="address">Rechercher un lieu</label>
      <div class="row">
        <input id="address" type="search" placeholder="Ex. Cléden-Cap-Sizun" autocomplete="street-address">
        <button type="submit">Rechercher</button>
      </div>
      <div id="search-results" class="results" aria-live="polite"></div>
    </form>

    <section class="block compact-block">
      <h2>Vue</h2>
      <label><input name="base-mode" type="radio" value="topo" checked> BD topo / Plan IGN</label>
      <label><input name="base-mode" type="radio" value="satellite"> Satellite IGN</label>
      <label><input name="base-mode" type="radio" value="itowns"> Vue iTowns avancée</label>
    </section>

    <section class="block compact-block">
      <h2>Angle</h2>
      <label><input name="camera-mode" type="radio" value="flat" checked> 2D verticale</label>
      <label><input name="camera-mode" type="radio" value="oblique"> 3D légère</label>
      <button id="reset-flat" type="button">Revenir en 2D</button>
    </section>

    <section class="block" id="itowns-tools">
      <h2>LiDAR IGN</h2>
      <p class="hint">Tracez un rectangle sur la carte. Le chargement local est recommandé, car il permet les lectures partielles requises par COPC.</p>
      <button id="select-rectangle" type="button">Sélectionner une zone</button>
      <div class="selection-summary">
        <strong>Zone</strong>
        <span id="bbox-output">Aucune zone sélectionnée.</span>
      </div>
      <button id="query-lidar" type="button" disabled>Rechercher les dalles LiDAR IGN</button>
      <div id="lidar-results" class="lidar-list" aria-live="polite"></div>

      <details class="advanced-details">
        <summary>Option avancée : charger une URL COPC</summary>
        <label>URL COPC directe
          <input id="copc-url" type="url" placeholder="https://.../*.copc.laz">
        </label>
        <button id="load-copc-url" type="button">Tester et charger cette URL</button>
      </details>

      <button id="clear-lidar" type="button">Retirer le LiDAR chargé</button>
    </section>

    <section class="block operation-block">
      <h2>Opération en cours</h2>
      <div id="lidar-operation" class="operation-card">Aucun chargement LiDAR lancé.</div>
      <progress id="download-progress" max="1" value="0" hidden></progress>
      <button id="cancel-download" type="button" hidden>Annuler le téléchargement</button>
    </section>

    <section class="block diagnostics-block">
      <h2>Diagnostic COPC</h2>
      <div id="diagnostics" class="diagnostics-list">
        <div class="diagnostic-step pending">Aucun diagnostic lancé.</div>
      </div>
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
const viewerElement = viewerDiv;

const statusOutput = document.querySelector<HTMLDivElement>('#status');
const searchResults = document.querySelector<HTMLDivElement>('#search-results');
const bboxOutput = document.querySelector<HTMLElement>('#bbox-output');
const queryLidarButton = document.querySelector<HTMLButtonElement>('#query-lidar');
const lidarResults = document.querySelector<HTMLDivElement>('#lidar-results');
const lidarOperation = document.querySelector<HTMLDivElement>('#lidar-operation');
const diagnosticsOutput = document.querySelector<HTMLDivElement>('#diagnostics');
const selectionOverlay = document.querySelector<HTMLDivElement>('#selection-overlay');
const selectionRect = document.querySelector<HTMLDivElement>('#selection-rect');
const copcUrlInput = document.querySelector<HTMLInputElement>('#copc-url');
const downloadProgress = document.querySelector<HTMLProgressElement>('#download-progress');
const cancelDownloadButton = document.querySelector<HTMLButtonElement>('#cancel-download');

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
const OBLIQUE_TILT = 62;
const NETWORK_TIMEOUT_MS = 15_000;
const COPC_METADATA_TIMEOUT_MS = 25_000;
const COPC_LAYER_TIMEOUT_MS = 35_000;
const COPC_RENDER_TIMEOUT_MS = 35_000;

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
let selectedBBox: BBox4326 | null = null;
let selecting = false;
let draggingSelection = false;
let selectionStart: { x: number; y: number } | null = null;
let cameraTarget = { lon: DEFAULT_LON, lat: DEFAULT_LAT, range: DEFAULT_RANGE };
let activeDownloadJobId: string | null = null;
let loadSequence = 0;

function setStatus(message: string): void {
  if (statusOutput) statusOutput.textContent = message;
}

function setOperation(message: string, detail?: string): void {
  if (!lidarOperation) return;
  lidarOperation.innerHTML = '';
  const main = document.createElement('strong');
  main.textContent = message;
  lidarOperation.appendChild(main);
  if (detail) {
    const small = document.createElement('div');
    small.className = 'small';
    small.textContent = detail;
    lidarOperation.appendChild(small);
  }
}

function resetDiagnostics(): void {
  if (diagnosticsOutput) diagnosticsOutput.innerHTML = '';
}

function setDiagnostic(id: string, label: string, state: StepState, detail?: string): void {
  if (!diagnosticsOutput) return;
  let step = diagnosticsOutput.querySelector<HTMLElement>(`[data-step="${id}"]`);
  if (!step) {
    step = document.createElement('div');
    step.dataset.step = id;
    diagnosticsOutput.appendChild(step);
  }
  step.className = `diagnostic-step ${state}`;
  step.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = label;
  step.appendChild(title);
  if (detail) {
    const small = document.createElement('span');
    small.textContent = detail;
    step.appendChild(small);
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
    timer = window.setTimeout(() => reject(new Error(`${label} : délai dépassé (${Math.round(milliseconds / 1000)} s)`)), milliseconds);
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
    if (controller.signal.aborted) throw new Error(`Requête interrompue après ${Math.round(timeoutMs / 1000)} s`);
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
      // La réponse distante n'est pas forcément JSON.
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
  if (mode === 'itowns') return { label: 'Vue iTowns avancée', layerName: topoLayerName, format: 'image/png' };
  return { label: 'BD topo / Plan IGN', layerName: topoLayerName, format: 'image/png' };
}

async function removeActiveBaseLayer(): Promise<void> {
  if (!activeLayerId) return;
  try {
    const existing = view.getLayerById(activeLayerId);
    if (existing) await Promise.resolve(view.removeLayer(activeLayerId, true));
  } catch (error) {
    console.warn('Suppression de couche impossible', error);
  } finally {
    activeLayerId = null;
  }
}

async function setBaseMode(mode: BaseMode): Promise<void> {
  const switchId = ++layerSwitchSequence;
  setRadioValue('base-mode', mode);
  setStatus('Changement de vue…');
  await removeActiveBaseLayer();
  if (switchId !== layerSwitchSequence) return;

  const config = layerConfig(mode);
  const layerId = `base-${mode}-${switchId}`;
  const layer = createWmtsLayer(layerId, config.layerName, config.format);
  activeLayerId = layerId;
  await view.addLayer(layer as never);
  if (switchId !== layerSwitchSequence) return;

  setStatus(mode === 'itowns'
    ? 'Vue iTowns avancée active. Le LiDAR sera superposé au fond topo.'
    : `${config.label} actif en ${cameraMode === 'flat' ? 'vue 2D verticale' : 'vue 3D légère'}.`);
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
  setStatus(label ? `Position atteinte : ${label}` : `Position atteinte : ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
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
  setStatus('Recherche d’adresse…');
  const data = await fetchJson<GeocodeResponse>(`${apiUrl}/geocode/search?q=${encodeURIComponent(value)}&limit=5`);
  const features = data.features ?? [];
  renderSearchResults(features);
  if (features[0]) {
    const [lon, lat] = features[0].geometry.coordinates;
    const label = features[0].properties.label ?? features[0].properties.name;
    applyCamera(lon, lat, label, DEFAULT_RANGE);
  } else {
    setStatus('Aucune adresse trouvée.');
  }
}

function screenPointToLonLat(x: number, y: number): { lon: number; lat: number } | null {
  try {
    const picked = new THREE.Vector3();
    view.getPickingPositionFromDepth(new THREE.Vector2(x, y), picked);
    if (![picked.x, picked.y, picked.z].every(Number.isFinite)) return null;
    const coords = new itowns.Coordinates(view.referenceCrs).setFromVector3(picked).as('EPSG:4326');
    if (!Number.isFinite(coords.longitude) || !Number.isFinite(coords.latitude)) return null;
    return { lon: coords.longitude, lat: coords.latitude };
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

function setSelectedBBox(bbox: BBox4326): void {
  selectedBBox = bbox;
  if (bboxOutput) bboxOutput.textContent = 'Zone sélectionnée.';
  if (queryLidarButton) queryLidarButton.disabled = false;
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

function finishSelection(x0: number, y0: number, x1: number, y1: number): void {
  if (Math.abs(x1 - x0) < 12 || Math.abs(y1 - y0) < 12) {
    stopSelectionMode();
    setStatus('Sélection trop petite. Tracez un rectangle plus large.');
    return;
  }
  const a = screenPointToLonLat(x0, y0);
  const b = screenPointToLonLat(x1, y1);
  if (!a || !b) {
    stopSelectionMode();
    setStatus('Sélection impossible : revenez en vue 2D puis réessayez.');
    return;
  }
  setSelectedBBox({
    minLon: Math.min(a.lon, b.lon),
    minLat: Math.min(a.lat, b.lat),
    maxLon: Math.max(a.lon, b.lon),
    maxLat: Math.max(a.lat, b.lat),
  });
  stopSelectionMode();
  setStatus('Zone sélectionnée. Vous pouvez rechercher les dalles LiDAR IGN.');
}

function enableRectangleSelection(): void {
  if (selectionRect) selectionRect.style.display = 'none';
  selecting = true;
  draggingSelection = false;
  selectionStart = null;
  setControlsEnabled(false);
  document.body.classList.add('selection-active');
  setCameraMode('flat');
  setStatus('Sélection active : la carte est bloquée, glissez pour tracer le rectangle.');
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
  const props = feature.properties ?? {};
  for (const key of ['nom', 'name', 'id', 'identifier', 'filename', 'fichier', 'libelle']) {
    const value = props[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return feature.id ?? `Dalle LiDAR ${index + 1}`;
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

function updateDownloadProgress(job: DownloadJob): void {
  if (!downloadProgress) return;
  downloadProgress.hidden = false;
  if (job.totalBytes && job.totalBytes > 0) {
    downloadProgress.max = job.totalBytes;
    downloadProgress.value = Math.min(job.bytesDownloaded ?? 0, job.totalBytes);
  } else {
    downloadProgress.removeAttribute('value');
  }
  const detail = job.totalBytes
    ? `${formatBytes(job.bytesDownloaded)} / ${formatBytes(job.totalBytes)}`
    : `${formatBytes(job.bytesDownloaded)} téléchargés`;
  setOperation('Téléchargement local en cours…', detail);
}

function hideDownloadControls(): void {
  if (downloadProgress) {
    downloadProgress.hidden = true;
    downloadProgress.value = 0;
  }
  if (cancelDownloadButton) cancelDownloadButton.hidden = true;
  activeDownloadJobId = null;
}

async function removeCurrentLidarLayer(): Promise<void> {
  if (!activeCopcLayerId) return;
  const layerId = activeCopcLayerId;
  activeCopcLayerId = null;
  const existing = view.getLayerById(layerId);
  if (existing) await Promise.resolve(view.removeLayer(layerId, true));
  notifyView();
}

async function clearLidarLayer(): Promise<void> {
  loadSequence += 1;
  await removeCurrentLidarLayer();
  setStatus('Couche LiDAR retirée.');
  setOperation('LiDAR retiré.');
}

async function probeCopcUrl(url: string): Promise<void> {
  setDiagnostic('range', 'Lecture HTTP partielle', 'running', 'Requête Range bytes=0-374');
  const response = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-374' } }, NETWORK_TIMEOUT_MS);
  if (response.status !== 206) {
    throw new Error(`Le serveur ne répond pas en 206 Partial Content (statut ${response.status})`);
  }
  const contentRange = response.headers.get('content-range');
  const bytes = await response.arrayBuffer();
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 4));
  if (signature !== 'LASF') throw new Error(`Signature LAS invalide : ${signature || 'vide'}`);
  setDiagnostic('range', 'Lecture HTTP partielle', 'success', contentRange ?? `${bytes.byteLength} octets reçus`);
  setDiagnostic('signature', 'En-tête LAS', 'success', 'Signature LASF détectée');
}

async function centerOnCopcSource(source: unknown): Promise<void> {
  const typedSource = source as {
    extent?: { as?: (crs: string) => { center: (target: unknown) => any; geodeticDimensions: (target: THREE.Vector2) => THREE.Vector2 } };
  };
  const extent = typedSource.extent?.as?.('EPSG:4326');
  if (!extent) throw new Error('Emprise COPC indisponible');
  const center = extent.center(new itowns.Coordinates('EPSG:4326'));
  const dimensions = extent.geodeticDimensions(new THREE.Vector2());
  const range = Math.max(dimensions.x, dimensions.y, 250) * 2.8;
  cameraTarget = { lon: center.longitude, lat: center.latitude, range };
  cameraMode = 'oblique';
  setRadioValue('camera-mode', 'oblique');
  if (!view.controls) throw new Error('Contrôles caméra indisponibles');
  await view.controls.lookAtCoordinate({ coord: center, range, tilt: OBLIQUE_TILT, heading: 0, time: 900 });
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
    const position = candidate.geometry?.getAttribute('position');
    points += position?.count ?? 0;
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
  throw new Error('La couche est prête, mais aucun point n’a été rendu dans le délai imparti');
}

async function addCopcLayer(url: string, label = 'LiDAR COPC', alreadyProbed = false): Promise<void> {
  const cleanUrl = url.trim();
  if (!cleanUrl) throw new Error('URL COPC vide');
  if (!isCopcUrl(cleanUrl)) throw new Error('Le fichier sélectionné n’est pas identifié comme .copc.laz');

  const sequence = ++loadSequence;
  if (!alreadyProbed) resetDiagnostics();
  setDiagnostic('url', 'URL COPC', 'success', cleanUrl);
  if (!alreadyProbed) await probeCopcUrl(cleanUrl);
  if (sequence !== loadSequence) return;

  await removeCurrentLidarLayer();
  if (sequence !== loadSequence) return;
  await setBaseMode('itowns');
  if (sequence !== loadSequence) return;
  cameraMode = 'oblique';
  setRadioValue('camera-mode', 'oblique');

  setOperation('Lecture des métadonnées COPC…', label);
  setDiagnostic('metadata', 'Métadonnées COPC', 'running', 'Lecture des VLR et du système de coordonnées');
  const source = new itowns.CopcSource({ url: cleanUrl, colorDepth: 16 });
  await withTimeout(Promise.resolve((source as unknown as { whenReady: Promise<unknown> }).whenReady), COPC_METADATA_TIMEOUT_MS, 'Métadonnées COPC');
  if (sequence !== loadSequence) return;

  const sourceInfo = source as unknown as {
    crs?: string;
    header?: { pointCount?: number; min?: number[]; max?: number[] };
    info?: { spacing?: number };
  };
  const pointCount = sourceInfo.header?.pointCount;
  setDiagnostic(
    'metadata',
    'Métadonnées COPC',
    'success',
    `${sourceInfo.crs ?? 'CRS détecté'}${pointCount ? ` · ${pointCount.toLocaleString('fr-FR')} points annoncés` : ''}`,
  );

  const layerId = `lidar-copc-${Date.now()}`;
  const layer = new itowns.CopcLayer(layerId, {
    source,
    pointBudget: 1_000_000,
    pointSize: 3,
    sseThreshold: 2,
    mode: itowns.PNTS_MODE.ELEVATION,
  });
  activeCopcLayerId = layerId;

  setOperation('Initialisation de l’octree COPC…', label);
  setDiagnostic('octree', 'Hiérarchie COPC', 'running', 'Chargement du nœud racine');
  try {
    await withTimeout(
      (itowns.View.prototype.addLayer as unknown as (this: typeof view, value: unknown) => Promise<unknown>).call(view, layer),
      COPC_LAYER_TIMEOUT_MS,
      'Initialisation de la couche COPC',
    );
  } catch (error) {
    const existing = view.getLayerById(layerId);
    if (existing) await Promise.resolve(view.removeLayer(layerId, true));
    if (activeCopcLayerId === layerId) activeCopcLayerId = null;
    throw error;
  }
  if (sequence !== loadSequence) return;
  setDiagnostic('octree', 'Hiérarchie COPC', 'success', 'Octree racine chargé');

  setOperation('Recentrage sur le nuage de points…', label);
  setDiagnostic('camera', 'Recentrage caméra', 'running');
  await centerOnCopcSource(source);
  setDiagnostic('camera', 'Recentrage caméra', 'success', 'Vue 3D positionnée sur l’emprise COPC');

  setOperation('Décodage des premiers points…', 'Le décodeur LAZ WebAssembly est lancé dans un worker.');
  setDiagnostic('render', 'Points visibles', 'running', 'Attente du premier nœud décodé');
  const stats = await waitForRenderedPoints(layer, sequence);
  setDiagnostic('render', 'Points visibles', 'success', `${stats.points.toLocaleString('fr-FR')} points dans ${stats.nodes} nœud(s)`);
  setStatus(`LiDAR COPC affiché : ${label}`);
  setOperation('LiDAR COPC visible.', `${label} · ${stats.points.toLocaleString('fr-FR')} points actuellement rendus`);
}

async function pollDownloadJob(jobId: string): Promise<DownloadJob> {
  while (true) {
    const job = await fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads/${jobId}`);
    updateDownloadProgress(job);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error ?? 'Téléchargement local en échec');
    if (job.status === 'cancelled') throw new Error('Téléchargement annulé');
    await delay(700);
  }
}

async function downloadAndLoadCopc(url: string, label: string): Promise<void> {
  if (!isCopcUrl(url)) throw new Error('Cette dalle n’est pas identifiée comme COPC');
  resetDiagnostics();
  setDiagnostic('download', 'Cache local', 'running', 'Création du téléchargement');
  const initial = await fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  activeDownloadJobId = initial.id;
  if (cancelDownloadButton) cancelDownloadButton.hidden = false;

  try {
    const job = await pollDownloadJob(initial.id);
    if (!job.path) throw new Error('Téléchargement terminé sans chemin local');
    setDiagnostic('download', 'Cache local', 'success', `${job.filename ?? job.path} · ${formatBytes(job.totalBytes)}`);
    const localUrl = `${apiUrl}${job.path}`;
    setOperation('Fichier prêt. Vérification des lectures partielles…', localUrl);
    await probeCopcUrl(localUrl);
    await addCopcLayer(localUrl, `${label} depuis cache local`, true);
  } finally {
    hideDownloadControls();
  }
}

function renderLidarFeatures(features: LidarFeature[]): void {
  if (!lidarResults) return;
  lidarResults.innerHTML = '';
  if (features.length === 0) {
    lidarResults.textContent = 'Aucune dalle LiDAR trouvée sur cette zone.';
    return;
  }

  features.forEach((feature, index) => {
    const card = document.createElement('div');
    card.className = 'lidar-card';
    const label = featureLabel(feature, index);
    const downloadUrl = feature.downloadUrl ?? findDownloadUrl(feature.properties);
    const copc = Boolean(feature.isCopc ?? (downloadUrl ? isCopcUrl(downloadUrl) : false));

    const title = document.createElement('strong');
    title.textContent = label;
    card.appendChild(title);

    const detail = document.createElement('div');
    detail.className = 'small';
    detail.textContent = !downloadUrl
      ? 'Dalle trouvée, mais aucune URL LAZ/COPC exploitable n’a été détectée.'
      : copc
        ? 'Dalle COPC détectée. Le cache local est le parcours recommandé.'
        : 'Dalle LAZ classique : conversion COPC nécessaire avant affichage.';
    card.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'lidar-actions';

    const localLoad = document.createElement('button');
    localLoad.type = 'button';
    localLoad.textContent = 'Télécharger et afficher';
    localLoad.disabled = !downloadUrl || !copc;
    localLoad.title = 'Télécharge la dalle sur le serveur local, vérifie Range, puis confirme que des points sont visibles.';
    localLoad.addEventListener('click', () => {
      if (downloadUrl) void downloadAndLoadCopc(downloadUrl, label).catch(showLoadError);
    });

    const directLoad = document.createElement('button');
    directLoad.type = 'button';
    directLoad.textContent = 'Essai direct';
    directLoad.disabled = !downloadUrl || !copc;
    directLoad.title = 'Expérimental : dépend du CORS et du support Range du serveur distant.';
    directLoad.addEventListener('click', () => {
      if (downloadUrl) void addCopcLayer(downloadUrl, label).catch(showLoadError);
    });

    actions.appendChild(localLoad);
    actions.appendChild(directLoad);
    card.appendChild(actions);

    if (downloadUrl && copcUrlInput) {
      const useUrl = document.createElement('button');
      useUrl.type = 'button';
      useUrl.textContent = 'Copier dans URL avancée';
      useUrl.className = 'wide-action';
      useUrl.addEventListener('click', () => { copcUrlInput.value = downloadUrl; });
      card.appendChild(useUrl);
    }
    lidarResults.appendChild(card);
  });
}

async function queryLidarTiles(): Promise<void> {
  if (!selectedBBox) {
    setStatus('Aucune zone sélectionnée.');
    return;
  }
  const bbox = `${selectedBBox.minLon},${selectedBBox.minLat},${selectedBBox.maxLon},${selectedBBox.maxLat}`;
  setOperation('Recherche des dalles LiDAR…', bbox);
  setStatus('Recherche des dalles LiDAR HD IGN…');
  const data = await fetchJson<LidarResponse>(`${apiUrl}/lidar/tiles?bbox=${encodeURIComponent(bbox)}&limit=20`, {}, 25_000);
  const features = data.features ?? [];
  renderLidarFeatures(features);
  setStatus(`${features.length} dalle(s) LiDAR trouvée(s) pour la zone.`);
  setOperation('Recherche terminée.', `${features.length} dalle(s) trouvée(s).`);
}

function showLoadError(error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`Erreur COPC : ${message}`);
  setOperation('Échec du chargement COPC.', message);
  setDiagnostic('error', 'Erreur', 'error', message);
  hideDownloadControls();
}

function overlayEventPosition(event: PointerEvent): { x: number; y: number } {
  const rect = viewerElement.getBoundingClientRect();
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
  setStatus('Sélection annulée.');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selecting) {
    stopSelectionMode();
    if (selectionRect) selectionRect.style.display = 'none';
    setStatus('Sélection annulée.');
  }
});

window.addEventListener('error', (event) => {
  console.error(event.error ?? event.message);
  setStatus(`Erreur carte : ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
  setStatus(`Erreur carte : ${String(event.reason)}`);
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
    setStatus(`Erreur recherche : ${String(error)}`);
  });
});

document.querySelector<HTMLButtonElement>('#reset-flat')?.addEventListener('click', () => setCameraMode('flat'));
document.querySelector<HTMLButtonElement>('#select-rectangle')?.addEventListener('click', enableRectangleSelection);
document.querySelector<HTMLButtonElement>('#query-lidar')?.addEventListener('click', () => {
  void queryLidarTiles().catch((error: unknown) => {
    console.error(error);
    setStatus(`Erreur recherche LiDAR : ${String(error)}`);
    setOperation('Échec recherche LiDAR.', String(error));
  });
});

document.querySelector<HTMLButtonElement>('#load-copc-url')?.addEventListener('click', () => {
  const url = copcUrlInput?.value ?? '';
  void addCopcLayer(url, 'URL manuelle').catch(showLoadError);
});

document.querySelector<HTMLButtonElement>('#clear-lidar')?.addEventListener('click', () => {
  void clearLidarLayer().catch(showLoadError);
});

cancelDownloadButton?.addEventListener('click', () => {
  if (!activeDownloadJobId) return;
  cancelDownloadButton.disabled = true;
  void fetchJson<DownloadJob>(`${apiUrl}/lidar/downloads/${activeDownloadJobId}`, { method: 'DELETE' })
    .catch(showLoadError)
    .finally(() => { cancelDownloadButton.disabled = false; });
});

document.querySelectorAll<HTMLInputElement>('input[name="base-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) void setBaseMode(input.value as BaseMode).catch(showLoadError);
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="camera-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setCameraMode(input.value as CameraMode);
  });
});
