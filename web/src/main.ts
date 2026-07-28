import * as itowns from 'itowns';
import './style.css';

type ViewMode = 'satellite' | 'topo' | 'itowns';

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
        <input id="address" type="search" placeholder="Ex. 8 avenue des Champs-Élysées, Paris" autocomplete="street-address">
        <button type="submit">Rechercher</button>
      </div>
      <div id="search-results" class="results" aria-live="polite"></div>
    </form>

    <section class="block">
      <label>Longitude <input id="lon" type="number" step="0.0001" value="2.3522"></label>
      <label>Latitude <input id="lat" type="number" step="0.0001" value="48.8566"></label>
      <label>Altitude caméra <input id="alt" type="number" step="10" value="1500"></label>
      <button id="go" type="button">Aller à la position</button>
    </section>

    <section class="block">
      <h2>Vue</h2>
      <label><input name="view-mode" type="radio" value="satellite" checked> Satellite IGN</label>
      <label><input name="view-mode" type="radio" value="topo"> Plan IGN / topo</label>
      <label><input name="view-mode" type="radio" value="itowns"> iTowns 3D neutre</label>
    </section>

    <p class="hint">La recherche utilise le géocodage Géoplateforme. Les couches LiDAR, CoSIA et MNT seront ajoutées comme modules séparés.</p>
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

const placement = {
  coord: new itowns.Coordinates('EPSG:4326', 2.3522, 48.8566),
  range: 1500,
  tilt: 35,
  heading: 0,
};

const view = new itowns.GlobeView(viewerDiv, placement);
const baseLayers = new Map<ViewMode, any>();

function setStatus(message: string): void {
  if (status) status.textContent = message;
}

function notifyView(): void {
  view.notifyChange();
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

async function initBaseLayers(): Promise<void> {
  const satellite = createWmtsLayer('base-satellite', satelliteLayerName, 'image/jpeg');
  const topo = createWmtsLayer('base-topo', topoLayerName, 'image/png');

  baseLayers.set('satellite', satellite);
  baseLayers.set('topo', topo);

  await view.addLayer(satellite);
  await view.addLayer(topo);

  setViewMode('satellite');
  setStatus('Vue prête. Recherchez une adresse ou choisissez un mode de vue.');
}

function setViewMode(mode: ViewMode): void {
  for (const [layerMode, layer] of baseLayers.entries()) {
    layer.visible = mode === layerMode;
  }

  if (mode === 'itowns') {
    setStatus('Vue iTowns neutre : aucune couche image n’est affichée.');
  } else if (mode === 'topo') {
    setStatus('Vue Plan IGN / topo active.');
  } else {
    setStatus('Vue satellite IGN active.');
  }

  notifyView();
}

function centerOn(lon: number, lat: number, label?: string): void {
  const range = Number(altInput?.value ?? 1500) || 1500;

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
    tilt: 35,
    heading: 0,
    time: 1200,
  });

  setStatus(label ? `Position atteinte : ${label}` : `Position atteinte : ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
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
    button.addEventListener('click', () => centerOn(lon, lat, label));
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
    centerOn(lon, lat, label);
  } else {
    setStatus('Aucune adresse trouvée.');
  }
}

void initBaseLayers().catch((error: unknown) => {
  console.error(error);
  setStatus(`Erreur couches IGN : ${String(error)}`);
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
  const lon = Number(lonInput?.value ?? 2.3522);
  const lat = Number(latInput?.value ?? 48.8566);
  centerOn(lon, lat);
});

document.querySelectorAll<HTMLInputElement>('input[name="view-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setViewMode(input.value as ViewMode);
  });
});
