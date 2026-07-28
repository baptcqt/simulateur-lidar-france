import * as THREE from 'three';
import * as itowns from 'itowns';
import './style.css';

type BaseMode = 'topo' | 'satellite' | 'itowns';
type CameraMode = 'flat' | 'oblique';

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
};

type LidarResponse = { features?: LidarFeature[] };

type BBox4326 = { minLon: number; minLat: number; maxLon: number; maxLat: number };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Élément #app introuvable');

app.innerHTML = `
  <aside class="panel">
    <h1>Simulateur LiDAR France</h1>
    <p>Prototype iTowns centré sur les données IGN.</p>

    <form id="address-form" class="block">
      <label for="address">Recherche d’adresse</label>
      <div class="row">
        <input id="address" type="search" placeholder="Ex. Cléden-Cap-Sizun" autocomplete="street-address">
        <button type="submit">Rechercher</button>
      </div>
      <div id="search-results" class="results" aria-live="polite"></div>
    </form>

    <section class="block">
      <label>Longitude <input id="lon" type="number" step="0.0001" value="2.3522"></label>
      <label>Latitude <input id="lat" type="number" step="0.0001" value="48.8566"></label>
      <label>Distance caméra <input id="alt" type="number" step="10" value="2500"></label>
      <button id="go" type="button">Aller à la position</button>
    </section>

    <section class="block">
      <h2>Vue</h2>
      <label><input name="base-mode" type="radio" value="topo" checked> BD topo / Plan IGN</label>
      <label><input name="base-mode" type="radio" value="satellite"> Satellite IGN</label>
      <label><input name="base-mode" type="radio" value="itowns"> Vue iTowns avancée</label>
      <p class="hint">La vue iTowns avancée utilise le moteur iTowns avec ses couches 3D : COPC, point cloud, sélection et futurs filtres.</p>
    </section>

    <section class="block">
      <h2>Angle de vue</h2>
      <label><input name="camera-mode" type="radio" value="flat" checked> 2D verticale du dessus</label>
      <label><input name="camera-mode" type="radio" value="oblique"> 3D légère</label>
      <button id="reset-flat" type="button">Revenir en vue 2D verticale</button>
    </section>

    <section class="block" id="itowns-tools">
      <h2>Outils iTowns / LiDAR</h2>
      <span class="badge">COPC</span> <span class="badge">PointCloudLayer</span> <span class="badge">Sélection</span>
      <p class="hint">Sélectionnez un rectangle en vue 2D, puis recherchez les dalles LiDAR HD IGN qui intersectent cette emprise.</p>
      <button id="select-rectangle" type="button">Activer la sélection rectangle</button>
      <label>Emprise sélectionnée
        <code id="bbox-output">Aucune sélection.</code>
      </label>
      <button id="query-lidar" type="button" disabled>Rechercher les dalles LiDAR IGN</button>
      <div id="lidar-results" class="lidar-list" aria-live="polite"></div>
      <label>Charger un COPC par URL
        <input id="copc-url" type="url" placeholder="https://data.geopf.fr/telechargement/download/...copc.laz">
      </label>
      <button id="load-copc-url" type="button">Charger cette URL COPC dans iTowns</button>
      <button id="clear-lidar" type="button">Retirer le LiDAR chargé</button>
    </section>

    <p class="hint">Les fonds BD topo et Satellite sont des couches image IGN. La vue iTowns avancée garde un fond de repère et ajoute les outils natifs iTowns pour charger du LiDAR/COPC.</p>
    <div id="status">Initialisation…</div>
  </aside>
  <main id="viewer">
    <div id="selection-overlay"><div id="selection-rect"></div></div>
  </main>
`;

const viewerDiv = document.querySelector<HTMLDivElement>('#viewer');
if (!viewerDiv) throw new Error('Élément #viewer introuvable');

const status = document.querySelector<HTMLDivElement>('#status');
const searchResults = document.querySelector<HTMLDivElement>('#search-results');
const lonInput = document.querySelector<HTMLInputElement>('#lon');
const latInput = document.querySelector<HTMLInputElement>('#lat');
const altInput = document.querySelector<HTMLInputElement>('#alt');
const bboxOutput = document.querySelector<HTMLElement>('#bbox-output');
const queryLidarButton = document.querySelector<HTMLButtonElement>('#query-lidar');
const lidarResults = document.querySelector<HTMLDivElement>('#lidar-results');
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
let activeBaseMode: BaseMode = 'topo';
let activeLayerId: string | null = null;
let activeCopcLayerId: string | null = null;
let cameraMode: CameraMode = 'flat';
let layerSwitchSequence = 0;
let selectedBBox: BBox4326 | null = null;
let selecting = false;
let draggingSelection = false;
let selectionStart: { x: number; y: number } | null = null;

function setStatus(message: string): void {
  if (status) status.textContent = message;
}

function notifyView(): void {
  view.notifyChange();
}

function currentTilt(): number {
  return cameraMode === 'flat' ? FLAT_TILT : OBLIQUE_TILT;
}

function currentPosition(): { lon: number; lat: number; range: number } {
  return {
    lon: Number(lonInput?.value ?? DEFAULT_LON) || DEFAULT_LON,
    lat: Number(latInput?.value ?? DEFAULT_LAT) || DEFAULT_LAT,
    range: Number(altInput?.value ?? DEFAULT_RANGE) || DEFAULT_RANGE,
  };
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
  activeBaseMode = mode;
  setStatus('Changement de vue…');

  await removeActiveBaseLayer();
  if (switchId !== layerSwitchSequence) return;

  const config = layerConfig(mode);
  const layerId = `base-${mode}-${switchId}`;
  const layer = createWmtsLayer(layerId, config.layerName, config.format);
  activeLayerId = layerId;

  await view.addLayer(layer);
  if (switchId !== layerSwitchSequence) return;

  if (mode === 'itowns') {
    setStatus('Vue iTowns avancée active : moteur iTowns, sélection LiDAR et chargement COPC disponibles.');
  } else {
    setStatus(`${config.label} actif en ${cameraMode === 'flat' ? 'vue 2D verticale' : 'vue 3D légère'}.`);
  }
  notifyView();
}

function applyCamera(lon: number, lat: number, label?: string): void {
  const range = Number(altInput?.value ?? DEFAULT_RANGE) || DEFAULT_RANGE;

  if (lonInput) lonInput.value = lon.toFixed(6);
  if (latInput) latInput.value = lat.toFixed(6);

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
  const { lon, lat } = currentPosition();
  applyCamera(lon, lat, mode === 'flat' ? 'vue 2D verticale du dessus' : 'vue 3D légère');
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
    button.addEventListener('click', () => applyCamera(lon, lat, label));
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
    applyCamera(lon, lat, label);
  } else {
    setStatus('Aucune adresse trouvée.');
  }
}

function screenPointToLonLat(x: number, y: number): { lon: number; lat: number } | null {
  try {
    const picked = new THREE.Vector3();
    const viewCoords = new THREE.Vector2(x, y);
    view.getPickingPositionFromDepth(viewCoords, picked);
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
  if (bboxOutput) {
    bboxOutput.textContent = `${bbox.minLon.toFixed(6)}, ${bbox.minLat.toFixed(6)}, ${bbox.maxLon.toFixed(6)}, ${bbox.maxLat.toFixed(6)}`;
  }
  if (queryLidarButton) queryLidarButton.disabled = false;
}

function finishSelection(x0: number, y0: number, x1: number, y1: number): void {
  const a = screenPointToLonLat(x0, y0);
  const b = screenPointToLonLat(x1, y1);
  if (!a || !b) {
    setStatus('Sélection impossible : repassez en vue 2D verticale puis réessayez.');
    return;
  }

  setSelectedBBox({
    minLon: Math.min(a.lon, b.lon),
    minLat: Math.min(a.lat, b.lat),
    maxLon: Math.max(a.lon, b.lon),
    maxLat: Math.max(a.lat, b.lat),
  });
  setStatus('Emprise sélectionnée. Vous pouvez rechercher les dalles LiDAR IGN.');
}

function enableRectangleSelection(): void {
  selecting = true;
  document.body.classList.add('selection-active');
  setCameraMode('flat');
  setStatus('Sélection rectangle active : glissez sur la carte pour définir l’emprise LiDAR.');
}

function findDownloadUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.includes('/telechargement/download/') && value.toLowerCase().endsWith('.laz') ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDownloadUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = findDownloadUrl(item);
      if (found) return found;
    }
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

async function addCopcLayer(url: string, label = 'LiDAR COPC'): Promise<void> {
  if (!url.trim()) {
    setStatus('URL COPC vide.');
    return;
  }

  await clearLidarLayer();
  setBaseMode('itowns').catch(console.error);
  cameraMode = 'oblique';
  const obliqueInput = document.querySelector<HTMLInputElement>('input[name="camera-mode"][value="oblique"]');
  if (obliqueInput) obliqueInput.checked = true;

  const source = new itowns.CopcSource({ url: url.trim(), colorDepth: 16 });
  const layerId = `lidar-copc-${Date.now()}`;
  const layer = new itowns.CopcLayer(layerId, {
    source,
    pointBudget: 700000,
    pointSize: 2,
    sseThreshold: 4,
  });

  activeCopcLayerId = layerId;
  setStatus(`Chargement COPC dans iTowns : ${label}`);
  await (itowns.View.prototype.addLayer as any).call(view, layer);
  setCameraMode('oblique');
  setStatus(`LiDAR COPC chargé : ${label}`);
}

async function clearLidarLayer(): Promise<void> {
  if (!activeCopcLayerId) return;
  const existing = view.getLayerById(activeCopcLayerId);
  if (existing) await Promise.resolve(view.removeLayer(activeCopcLayerId, true));
  activeCopcLayerId = null;
  notifyView();
  setStatus('Couche LiDAR retirée.');
}

function renderLidarFeatures(features: LidarFeature[]): void {
  if (!lidarResults) return;
  lidarResults.innerHTML = '';

  if (features.length === 0) {
    lidarResults.textContent = 'Aucune dalle LiDAR trouvée sur cette emprise.';
    return;
  }

  features.forEach((feature, index) => {
    const card = document.createElement('div');
    card.className = 'lidar-card';
    const label = featureLabel(feature, index);
    const downloadUrl = feature.downloadUrl ?? findDownloadUrl(feature.properties);

    const title = document.createElement('strong');
    title.textContent = label;
    card.appendChild(title);

    const detail = document.createElement('div');
    detail.className = 'small';
    detail.textContent = downloadUrl ? 'URL COPC détectée.' : 'URL COPC non trouvée dans les propriétés WFS.';
    card.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'lidar-actions';

    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = 'Charger COPC';
    load.disabled = !downloadUrl;
    load.addEventListener('click', () => {
      if (downloadUrl) void addCopcLayer(downloadUrl, label).catch((error: unknown) => {
        console.error(error);
        setStatus(`Erreur chargement COPC : ${String(error)}`);
      });
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Utiliser URL';
    copy.disabled = !downloadUrl;
    copy.addEventListener('click', () => {
      if (downloadUrl && copcUrlInput) copcUrlInput.value = downloadUrl;
    });

    actions.appendChild(load);
    actions.appendChild(copy);
    card.appendChild(actions);
    lidarResults.appendChild(card);
  });
}

async function queryLidarTiles(): Promise<void> {
  if (!selectedBBox) {
    setStatus('Aucune emprise sélectionnée.');
    return;
  }

  const bbox = `${selectedBBox.minLon},${selectedBBox.minLat},${selectedBBox.maxLon},${selectedBBox.maxLat}`;
  setStatus('Recherche des dalles LiDAR HD IGN sur la Géoplateforme…');
  const response = await fetch(`${apiUrl}/lidar/tiles?bbox=${encodeURIComponent(bbox)}&limit=20`);
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
  const data = (await response.json()) as LidarResponse;
  const features = data.features ?? [];
  renderLidarFeatures(features);
  setStatus(`${features.length} dalle(s) LiDAR trouvée(s) pour l’emprise sélectionnée.`);
}

viewerDiv.addEventListener('pointerdown', (event) => {
  if (!selecting) return;
  event.preventDefault();
  const rect = viewerDiv.getBoundingClientRect();
  selectionStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  draggingSelection = true;
  updateSelectionRect(selectionStart.x, selectionStart.y, selectionStart.x, selectionStart.y);
});

viewerDiv.addEventListener('pointermove', (event) => {
  if (!draggingSelection || !selectionStart) return;
  const rect = viewerDiv.getBoundingClientRect();
  updateSelectionRect(selectionStart.x, selectionStart.y, event.clientX - rect.left, event.clientY - rect.top);
});

viewerDiv.addEventListener('pointerup', (event) => {
  if (!draggingSelection || !selectionStart) return;
  const rect = viewerDiv.getBoundingClientRect();
  const end = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  draggingSelection = false;
  selecting = false;
  document.body.classList.remove('selection-active');
  finishSelection(selectionStart.x, selectionStart.y, end.x, end.y);
  selectionStart = null;
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

document.querySelector<HTMLButtonElement>('#go')?.addEventListener('click', () => {
  const { lon, lat } = currentPosition();
  applyCamera(lon, lat);
});

document.querySelector<HTMLButtonElement>('#reset-flat')?.addEventListener('click', () => {
  cameraMode = 'flat';
  const flatInput = document.querySelector<HTMLInputElement>('input[name="camera-mode"][value="flat"]');
  if (flatInput) flatInput.checked = true;
  const { lon, lat } = currentPosition();
  applyCamera(lon, lat, 'vue 2D verticale du dessus');
});

document.querySelector<HTMLButtonElement>('#select-rectangle')?.addEventListener('click', enableRectangleSelection);

document.querySelector<HTMLButtonElement>('#query-lidar')?.addEventListener('click', () => {
  void queryLidarTiles().catch((error: unknown) => {
    console.error(error);
    setStatus(`Erreur recherche LiDAR : ${String(error)}`);
  });
});

document.querySelector<HTMLButtonElement>('#load-copc-url')?.addEventListener('click', () => {
  const url = copcUrlInput?.value ?? '';
  void addCopcLayer(url, 'URL manuelle').catch((error: unknown) => {
    console.error(error);
    setStatus(`Erreur chargement COPC : ${String(error)}`);
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
