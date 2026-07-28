import * as THREE from 'three';
import * as itowns from 'itowns';
import './style.css';

type BaseMode = 'topo' | 'satellite' | 'itowns';
type CameraMode = 'flat' | 'oblique';
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

type LidarDownloadResponse = {
  filename?: string;
  path?: string;
  sizeBytes?: number;
  status?: 'cached' | 'downloaded';
};

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
      <p class="hint">Tracez un rectangle sur la carte. Pendant la sélection, la carte est bloquée et ne bouge pas.</p>
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
        <button id="load-copc-url" type="button">Charger cette URL COPC</button>
      </details>

      <button id="clear-lidar" type="button">Retirer le LiDAR chargé</button>
    </section>

    <section class="block operation-block">
      <h2>Opération en cours</h2>
      <div id="lidar-operation" class="operation-card">Aucun chargement LiDAR lancé.</div>
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

const status = document.querySelector<HTMLDivElement>('#status');
const searchResults = document.querySelector<HTMLDivElement>('#search-results');
const bboxOutput = document.querySelector<HTMLElement>('#bbox-output');
const queryLidarButton = document.querySelector<HTMLButtonElement>('#query-lidar');
const lidarResults = document.querySelector<HTMLDivElement>('#lidar-results');
const lidarOperation = document.querySelector<HTMLDivElement>('#lidar-operation');
const selectionOverlay = document.querySelector<HTMLDivElement>('#selection-overlay');
const selectionRect = document.querySelector<HTMLDivElement>('#selection-rect');
const copcUrlInput = document.querySelector<HTMLInputElement>('#copc-url');

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

function setStatus(message: string): void {
  if (status) status.textContent = message;
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

function notifyView(): void {
  view.notifyChange();
}

function currentTilt(): number {
  return cameraMode === 'flat' ? FLAT_TILT : OBLIQUE_TILT;
}

function setRadioValue(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
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

function layerConfig(mode: BaseMode): { label: string; layerName: string; format: string } {
  if (mode === 'satellite') {
    return { label: 'Satellite IGN', layerName: satelliteLayerName, format: 'image/jpeg' };
  }
  if (mode === 'itowns') {
    return { label: 'Vue iTowns avancée', layerName: topoLayerName, format: 'image/png' };
  }
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

  await view.addLayer(layer);
  if (switchId !== layerSwitchSequence) return;

  setStatus(mode === 'itowns'
    ? 'Vue iTowns avancée active. Le fond topo sert de repère, le LiDAR se charge par-dessus.'
    : `${config.label} actif en ${cameraMode === 'flat' ? 'vue 2D verticale' : 'vue 3D légère'}.`);
  notifyView();
}

function applyCamera(lon: number, lat: number, label?: string, range = cameraTarget.range): void {
  cameraTarget = { lon, lat, range };
  const controls = view.controls;
  if (!controls) {
    setStatus('Contrôles caméra indisponibles.');
    return;
  }

  void controls.lookAtCoordinate({
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
  const response = await fetch(`${apiUrl}/geocode/search?q=${encodeURIComponent(value)}&limit=5`);
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);

  const data = (await response.json()) as GeocodeResponse;
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
    if (!Number.isFinite(picked.x) || !Number.isFinite(picked.y) || !Number.isFinite(picked.z)) return null;

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
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  selectionRect.style.display = 'block';
  selectionRect.style.left = `${left}px`;
  selectionRect.style.top = `${top}px`;
  selectionRect.style.width = `${width}px`;
  selectionRect.style.height = `${height}px`;
}

function setSelectedBBox(bbox: BBox4326): void {
  selectedBBox = bbox;
  if (bboxOutput) bboxOutput.textContent = 'Zone sélectionnée.';
  if (queryLidarButton) queryLidarButton.disabled = false;
}

function setControlsEnabled(enabled: boolean): void {
  const controls = view.controls as any;
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
    if (/^https?:\/\//i.test(trimmed) && /\.laz(\?|#|$)/i.test(trimmed)) return trimmed;
    return null;
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
  const candidates = ['nom', 'name', 'id', 'identifier', 'filename', 'fichier', 'libelle'];
  for (const key of candidates) {
    const value = props[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return feature.id ?? `Dalle LiDAR ${index + 1}`;
}

function formatBytes(value?: number): string {
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

async function clearLidarLayer(): Promise<void> {
  if (!activeCopcLayerId) return;
  const existing = view.getLayerById(activeCopcLayerId);
  if (existing) await Promise.resolve(view.removeLayer(activeCopcLayerId, true));
  activeCopcLayerId = null;
  notifyView();
  setStatus('Couche LiDAR retirée.');
  setOperation('LiDAR retiré.');
}

async function centerOnCopcSource(source: any): Promise<void> {
  const extent = source?.extent?.as ? source.extent.as('EPSG:4326') : null;
  if (!extent) {
    setOperation('COPC chargé, mais emprise inconnue.', 'Le nuage est peut-être chargé hors champ.');
    return;
  }

  const center = extent.center(new itowns.Coordinates('EPSG:4326'));
  const dimensions = extent.geodeticDimensions(new THREE.Vector2());
  const range = Math.max(dimensions.x, dimensions.y, 250) * 2.8;
  cameraTarget = { lon: center.longitude, lat: center.latitude, range };
  cameraMode = 'oblique';
  setRadioValue('camera-mode', 'oblique');

  const controls = view.controls;
  if (!controls) return;
  await controls.lookAtCoordinate({
    coord: center,
    range,
    tilt: OBLIQUE_TILT,
    heading: 0,
    time: 1000,
  });
  notifyView();
}

async function addCopcLayer(url: string, label = 'LiDAR COPC'): Promise<void> {
  const cleanUrl = url.trim();
  if (!cleanUrl) {
    setStatus('URL COPC vide.');
    return;
  }
  if (!isCopcUrl(cleanUrl)) {
    setStatus('Cette URL semble être une dalle LAZ classique, pas un COPC. iTowns ne peut charger ici que du COPC.');
    setOperation('Chargement refusé.', 'Le moteur iTowns/CopcLayer attend une URL .copc.laz.');
    return;
  }

  await clearLidarLayer();
  await setBaseMode('itowns');
  cameraMode = 'oblique';
  setRadioValue('camera-mode', 'oblique');

  setOperation('Préparation COPC…', label);
  setStatus(`Analyse des métadonnées COPC : ${label}`);

  const source = new itowns.CopcSource({ url: cleanUrl, colorDepth: 16 });
  await Promise.resolve((source as any).whenReady);

  const layerId = `lidar-copc-${Date.now()}`;
  const layer = new itowns.CopcLayer(layerId, {
    source,
    pointBudget: 500000,
    pointSize: 3,
    sseThreshold: 4,
    mode: (itowns as any).PNTS_MODE?.CLASSIFICATION ?? 0,
  });

  activeCopcLayerId = layerId;
  setOperation('Ajout du nuage de points dans iTowns…', cleanUrl);
  setStatus(`Chargement COPC dans iTowns : ${label}`);
  await (itowns.View.prototype.addLayer as any).call(view, layer);
  await Promise.resolve((layer as any).whenReady);

  setOperation('Recentrage sur le LiDAR…', label);
  await centerOnCopcSource(source);
  setStatus(`LiDAR COPC chargé et caméra recentrée : ${label}`);
  setOperation('LiDAR COPC chargé.', `${label} — source : ${cleanUrl}`);
}

async function downloadAndLoadCopc(url: string, label: string): Promise<void> {
  if (!isCopcUrl(url)) {
    setStatus('Cette dalle n’est pas identifiée comme COPC. Chargement iTowns désactivé.');
    return;
  }

  setOperation('Téléchargement local en cours…', 'La dalle peut être lourde. La fenêtre peut rester silencieuse pendant le téléchargement.');
  setStatus('Téléchargement local de la dalle COPC. Cela peut prendre du temps.');
  const response = await fetch(`${apiUrl}/lidar/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
  const payload = (await response.json()) as LidarDownloadResponse;
  if (!payload.path) throw new Error('Réponse serveur sans chemin de fichier');
  const localUrl = `${apiUrl}${payload.path}`;
  setOperation('Fichier prêt dans le cache local.', `${payload.filename ?? payload.path} — ${formatBytes(payload.sizeBytes)}`);
  await addCopcLayer(localUrl, `${label} depuis cache local`);
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
    const isCopc = Boolean(feature.isCopc ?? (downloadUrl ? isCopcUrl(downloadUrl) : false));

    const title = document.createElement('strong');
    title.textContent = label;
    card.appendChild(title);

    const detail = document.createElement('div');
    detail.className = 'small';
    if (!downloadUrl) {
      detail.textContent = 'Dalle trouvée, mais aucune URL LAZ/COPC exploitable n’a été détectée.';
    } else if (!isCopc) {
      detail.textContent = 'Dalle LAZ détectée, mais pas COPC : affichage iTowns désactivé pour l’instant.';
    } else {
      detail.textContent = 'Dalle COPC détectée : elle peut être chargée dans iTowns.';
    }
    card.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'lidar-actions';

    const directLoad = document.createElement('button');
    directLoad.type = 'button';
    directLoad.textContent = 'Charger direct';
    directLoad.disabled = !downloadUrl || !isCopc;
    directLoad.addEventListener('click', () => {
      if (downloadUrl) void addCopcLayer(downloadUrl, label).catch((error: unknown) => {
        console.error(error);
        setStatus(`Erreur chargement direct : ${String(error)}`);
        setOperation('Échec chargement direct.', String(error));
      });
    });

    const localLoad = document.createElement('button');
    localLoad.type = 'button';
    localLoad.textContent = 'Cache local';
    localLoad.disabled = !downloadUrl || !isCopc;
    localLoad.title = 'Télécharge la dalle sur le serveur local, puis la charge depuis localhost.';
    localLoad.addEventListener('click', () => {
      if (downloadUrl) void downloadAndLoadCopc(downloadUrl, label).catch((error: unknown) => {
        console.error(error);
        setStatus(`Erreur cache COPC : ${String(error)}`);
        setOperation('Échec cache local.', String(error));
      });
    });

    actions.appendChild(directLoad);
    actions.appendChild(localLoad);
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
  const response = await fetch(`${apiUrl}/lidar/tiles?bbox=${encodeURIComponent(bbox)}&limit=20`);
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
  const data = (await response.json()) as LidarResponse;
  const features = data.features ?? [];
  renderLidarFeatures(features);
  setStatus(`${features.length} dalle(s) LiDAR trouvée(s) pour la zone.`);
  setOperation('Recherche terminée.', `${features.length} dalle(s) trouvée(s).`);
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

void setBaseMode('topo').then(() => {
  setCameraMode('flat');
}).catch((error: unknown) => {
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
  void addCopcLayer(url, 'URL manuelle').catch((error: unknown) => {
    console.error(error);
    setStatus(`Erreur chargement COPC : ${String(error)}`);
    setOperation('Échec chargement COPC.', String(error));
  });
});

document.querySelector<HTMLButtonElement>('#clear-lidar')?.addEventListener('click', () => {
  void clearLidarLayer().catch((error: unknown) => {
    console.error(error);
    setStatus(`Erreur suppression LiDAR : ${String(error)}`);
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="base-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) {
      void setBaseMode(input.value as BaseMode).catch((error: unknown) => {
        console.error(error);
        setStatus(`Erreur vue : ${String(error)}`);
      });
    }
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="camera-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setCameraMode(input.value as CameraMode);
  });
});
