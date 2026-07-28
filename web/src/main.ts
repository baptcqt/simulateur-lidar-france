import * as itowns from 'itowns';
import 'itowns/dist/itowns.css';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Élément #app introuvable');

app.innerHTML = `
  <aside class="panel">
    <h1>Simulateur LiDAR France</h1>
    <p>Prototype iTowns centré sur les données IGN.</p>
    <label>Longitude <input id="lon" type="number" step="0.0001" value="2.3522"></label>
    <label>Latitude <input id="lat" type="number" step="0.0001" value="48.8566"></label>
    <label>Altitude caméra <input id="alt" type="number" step="10" value="1500"></label>
    <button id="go">Aller à la position</button>
    <hr>
    <label><input id="ortho" type="checkbox" checked> Orthophoto IGN</label>
    <p class="hint">Souris : rotation et zoom. Les couches LiDAR, CoSIA et MNT seront ajoutées comme modules séparés.</p>
    <div id="status">Initialisation…</div>
  </aside>
  <main id="viewer"></main>
`;

const viewerDiv = document.querySelector<HTMLDivElement>('#viewer');
if (!viewerDiv) throw new Error('Élément #viewer introuvable');

const placement = {
  coord: new itowns.Coordinates('EPSG:4326', 2.3522, 48.8566),
  range: 1500,
  tilt: 35,
  heading: 0,
};

const view = new itowns.GlobeView(viewerDiv, placement);
const status = document.querySelector<HTMLDivElement>('#status');

const wmtsUrl = import.meta.env.VITE_IGN_WMTS_URL as string | undefined;
const wmtsLayer = import.meta.env.VITE_IGN_WMTS_LAYER as string | undefined;

async function addIgnOrtho(): Promise<void> {
  if (!wmtsUrl || !wmtsLayer) {
    if (status) status.textContent = 'Vue prête. Configurez VITE_IGN_WMTS_URL et VITE_IGN_WMTS_LAYER pour activer l’orthophoto.';
    return;
  }

  const source = new itowns.WMTSSource({
    url: wmtsUrl,
    name: wmtsLayer,
    tileMatrixSet: 'PM',
    format: 'image/jpeg',
    style: 'normal',
    crs: 'EPSG:3857',
  });

  const layer = new itowns.ColorLayer('ign-ortho', { source });
  await view.addLayer(layer);
  if (status) status.textContent = 'Vue iTowns et orthophoto IGN chargées.';
}

void addIgnOrtho().catch((error: unknown) => {
  console.error(error);
  if (status) status.textContent = `Erreur couche IGN : ${String(error)}`;
});

document.querySelector<HTMLButtonElement>('#go')?.addEventListener('click', () => {
  const lon = Number(document.querySelector<HTMLInputElement>('#lon')?.value ?? 2.3522);
  const lat = Number(document.querySelector<HTMLInputElement>('#lat')?.value ?? 48.8566);
  const range = Number(document.querySelector<HTMLInputElement>('#alt')?.value ?? 1500);

  const controls = view.controls;
  if (!controls) {
    if (status) status.textContent = 'Contrôles caméra indisponibles.';
    return;
  }

  void controls.lookAtCoordinate({
    coord: new itowns.Coordinates('EPSG:4326', lon, lat),
    range,
    tilt: 35,
    heading: 0,
    time: 1200,
  });
});

document.querySelector<HTMLInputElement>('#ortho')?.addEventListener('change', (event) => {
  const visible = (event.target as HTMLInputElement).checked;
  const layer = view.getLayerById('ign-ortho');
  if (layer) layer.visible = visible;
  view.notifyChange();
});
