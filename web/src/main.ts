import * as itowns from 'itowns';
import './style.css';

type BaseMode = 'topo' | 'satellite' | 'alternate';
type CameraMode = 'flat' | 'oblique';

type GeocodeFeature = {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: {
    label?: string;
    name?: string;
    city?: string;
    postcode?: string;
    score?: number;
  };
};

type GeocodeResponse = {
  type: 'FeatureCollection';
  features?: GeocodeFeature[];
};

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
      <label>Altitude caméra <input id="alt" type="number" step="10" value="2500"></label>
      <button id="go" type="button">Aller à la position</button>
    </section>

    <section class="block">
      <h2>Fond de carte</h2>
      <label><input name="base-mode" type="radio" value="topo" checked> BD topo / Plan IGN</label>
      <label><input name="base-mode" type="radio" value="satellite"> Satellite IGN</label>
      <label><input name="base-mode" type="radio" value="alternate"> Alternate iTowns</label>
    </section>

    <section class="block">
      <h2>Angle de vue</h2>
      <label><input name="camera-mode" type="radio" value="flat" checked> 2D verticale du dessus</label>
      <label><input name="camera-mode" type="radio" value="oblique"> 3D légère</label>
      <button id="reset-flat" type="button">Revenir en vue 2D verticale</button>
    </section>

    <p class="hint">La vue 2D utilise une caméra verticale. La 3D légère garde un angle modéré pour éviter la vue rasante et limiter le chargement de tuiles à l’horizon.</p>
    <div id="status">Initialisation…</div>
  </aside>
  <main id="viewer"></main>
`;

const viewerDiv = document.querySelector<HTMLDivElement>('#viewer');
if (!viewerDiv) throw new Error('Élément #viewer introuvable');

const status = document.querySelector<HTMLDivElement>('#status');
const searchResults = document.querySelector<HTMLDivElement>('#search-results');
const lonInput = document.querySelector<HTMLInputElement>('#lon');
const latInput = document.querySelector<HTMLInputElement>('#lat');
const altInput = document.querySelector<HTMLInputElement>('#alt');

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

// Dans iTowns, un tilt proche de 90° correspond à une caméra verticale.
// Un tilt proche de 0° donne une vue rasante avec horizon visible.
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
let cameraMode: CameraMode = 'flat';
let layerSwitchSequence = 0;

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

function layerConfig(mode: BaseMode): { label: string; layerName: string; format: string } | null {
  if (mode === 'topo') {
    return { label: 'BD topo / Plan IGN', layerName: topoLayerName, format: 'image/png' };
  }
  if (mode === 'satellite') {
    return { label: 'Satellite IGN', layerName: satelliteLayerName, format: 'image/jpeg' };
  }
  return null;
}

async function removeActiveBaseLayer(): Promise<void> {
  if (!activeLayerId) return;

  try {
    const existing = view.getLayerById(activeLayerId);
    if (existing) {
      await Promise.resolve(view.removeLayer(activeLayerId, true));
    }
  } catch (error) {
    console.warn('Suppression de couche impossible', error);
  } finally {
    activeLayerId = null;
  }
}

async function setBaseMode(mode: BaseMode): Promise<void> {
  const switchId = ++layerSwitchSequence;
  activeBaseMode = mode;
  setStatus('Changement de fond de carte…');

  await removeActiveBaseLayer();
  if (switchId !== layerSwitchSequence) return;

  const config = layerConfig(mode);
  if (!config) {
    setStatus('Vue alternate iTowns active : aucune image IGN n’est chargée.');
    notifyView();
    return;
  }

  const layerId = `base-${mode}-${switchId}`;
  const layer = createWmtsLayer(layerId, config.layerName, config.format);
  activeLayerId = layerId;

  await view.addLayer(layer);
  if (switchId !== layerSwitchSequence) return;

  setStatus(`${config.label} actif en ${cameraMode === 'flat' ? 'vue 2D verticale' : 'vue 3D légère'}.`);
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

  if (label) {
    setStatus(`Position atteinte : ${label}`);
  } else {
    setStatus(`Position atteinte : ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  }
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
  if (!response.ok) {
    throw new Error(`Erreur HTTP ${response.status}`);
  }

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

document.querySelectorAll<HTMLInputElement>('input[name="base-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) {
      void setBaseMode(input.value as BaseMode).catch((error: unknown) => {
        console.error(error);
        setStatus(`Erreur fond de carte : ${String(error)}`);
      });
    }
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="camera-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setCameraMode(input.value as CameraMode);
  });
});
