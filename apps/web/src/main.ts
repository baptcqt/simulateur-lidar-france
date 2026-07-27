import * as itowns from 'itowns';
import './style.css';

const api = 'http://127.0.0.1:8000';
const PLAN_LAYER = 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2';
const ORTHO_LAYER = 'ORTHOIMAGERY.ORTHOPHOTOS';
const LIDAR_MAP_LAYER = 'PLANIGN.LIDAR.TERRAIN';

type Place = { label: string; context: string; longitude: number; latitude: number; type: string };
type BBox = { west: number; south: number; east: number; north: number };

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<div class="shell">
  <aside id="sidebar" class="sidebar">
    <div class="brand"><div class="brand-mark">S</div><div><strong>SimMap</strong><small>Créateur LiDAR France</small></div></div>
    <button id="collapse" class="icon-button" title="Replier le panneau">☰</button>
    <div class="sidebar-scroll">
      <section class="panel-section">
        <h2>Emprise sélectionnée</h2>
        <div id="selection-empty" class="empty-state">Recherchez un lieu puis définissez la zone à générer.</div>
        <div id="selection-info" class="hidden metric-grid"></div>
        <label>Largeur <output id="width-value">300 m</output><input id="width" type="range" min="100" max="1500" step="50" value="300"></label>
        <label>Hauteur <output id="height-value">300 m</output><input id="height" type="range" min="100" max="1500" step="50" value="300"></label>
        <button id="select-zone" class="secondary">Définir la zone au centre</button>
      </section>
      <section class="panel-section">
        <h2>Disponibilité LiDAR HD</h2>
        <div id="lidar-status" class="status neutral"><span class="status-dot"></span><div><strong>Zone non vérifiée</strong><small>Sélectionnez une emprise.</small></div></div>
      </section>
      <section class="panel-section">
        <h2>Sources et outils</h2>
        <label class="check"><input type="checkbox" data-module="lidar" checked><span><strong>LiDAR HD IGN</strong><small>Sol, végétation, bâtiments</small></span></label>
        <label class="check"><input type="checkbox" data-module="mnt" checked><span><strong>MNT / terrain</strong><small>Maillage et altitudes</small></span></label>
        <label class="check"><input type="checkbox" data-module="bdtopo" checked><span><strong>BD TOPO®</strong><small>Bâtiments, routes, ouvrages</small></span></label>
        <label class="check"><input type="checkbox" data-module="ortho" checked><span><strong>BD ORTHO®</strong><small>Analyse visuelle et textures</small></span></label>
        <label class="check"><input type="checkbox" data-module="cosia" checked><span><strong>CoSIA</strong><small>Occupation du sol</small></span></label>
        <label class="check"><input type="checkbox" data-module="procedural" checked><span><strong>Reconstruction procédurale</strong><small>Toits, arbres, ponts, accès</small></span></label>
      </section>
      <section class="panel-section">
        <h2>Intelligence artificielle</h2>
        <label class="check"><input type="checkbox" data-module="ai-segmentation"><span><strong>Segmentation IA</strong><small>Optionnelle, désactivée par défaut</small></span></label>
        <label class="check"><input type="checkbox" data-module="ai-roofs"><span><strong>Affinage des toitures</strong><small>Repli déterministe si désactivé</small></span></label>
        <div class="notice">Le pipeline déterministe reste prioritaire. Aucun modèle lourd n’est téléchargé automatiquement.</div>
      </section>
      <section class="panel-section">
        <h2>Qualité de génération</h2>
        <label>Profil<select id="profile"><option value="surface">Surface Pro</option><option value="standard">Standard</option><option value="quality">Qualité</option></select></label>
        <label>Fidélité <output id="fidelity-value">45 %</output><input id="fidelity" type="range" min="0" max="100" value="45"></label>
        <div id="estimate" class="estimate"></div>
      </section>
    </div>
    <div class="generate-area">
      <button id="generate" class="primary" disabled>Générer la carte LiDAR</button>
      <div id="progress-wrap" class="progress-wrap hidden"><div class="progress-head"><strong id="progress-label">Préparation</strong><span id="progress-value">0 %</span></div><div class="progress"><div id="progress-bar"></div></div><small id="progress-message"></small></div>
    </div>
  </aside>
  <main class="map-stage">
    <div id="viewer"></div>
    <form id="search-form" class="search-box"><input id="search" autocomplete="off" placeholder="Rechercher une adresse, une commune ou un lieu…"><button>Rechercher</button><div id="results" class="search-results hidden"></div></form>
    <div class="layer-switcher"><button data-layer="plan" class="active">Plan IGN</button><button data-layer="ortho">Satellite</button><button data-layer="lidar">Carte LiDAR</button></div>
    <div id="selection-box" class="selection-box hidden"><span>Zone à générer</span></div>
    <div class="map-hint">Molette : zoom · glisser : déplacer · clic droit : incliner</div>
    <div id="toast" class="toast hidden"></div>
  </main>
</div>`;

const $ = (selector: string): any => document.querySelector(selector);
const viewer = document.querySelector<HTMLDivElement>('#viewer')!;
const view = new itowns.GlobeView(viewer, { longitude: 2.35, latitude: 46.6, altitude: 5_000_000 });
const layers: Record<string, any> = {};

function wmtsLayer(id: string, layer: string, format: string) {
  const source = new itowns.WMTSSource({
    url: 'https://data.geopf.fr/wmts',
    crs: 'EPSG:3857',
    format,
    name: layer,
    tileMatrixSet: 'PM',
    style: 'normal',
  });
  return new itowns.ColorLayer(id, { source, transparent: false });
}

async function initialiseLayers() {
  layers.plan = wmtsLayer('plan-ign', PLAN_LAYER, 'image/png');
  layers.ortho = wmtsLayer('bd-ortho', ORTHO_LAYER, 'image/jpeg');
  layers.lidar = wmtsLayer('plan-lidar', LIDAR_MAP_LAYER, 'image/png');
  await view.addLayer(layers.plan);
  await view.addLayer(layers.ortho);
  layers.ortho.visible = false;
  try {
    await view.addLayer(layers.lidar);
    layers.lidar.visible = false;
  } catch {
    layers.lidar = null;
  }
  view.notifyChange();
}
void initialiseLayers();

let center = { longitude: 2.35, latitude: 46.6 };
let selectedBBox: BBox | null = null;
let lidarAvailable = false;
let searchTimer: number | undefined;

function toast(message: string) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.remove('hidden');
  window.setTimeout(() => node.classList.add('hidden'), 3500);
}

function flyTo(longitude: number, latitude: number, altitude = 2600) {
  center = { longitude, latitude };
  const controls = view.controls as any;
  if (controls?.lookAtCoordinate) {
    controls.lookAtCoordinate({
      coord: new itowns.Coordinates('EPSG:4326', longitude, latitude),
      range: altitude,
      tilt: 25,
      heading: 0,
    }, false);
  }
  updateSelectionBox();
}

async function searchPlaces(query: string) {
  if (query.trim().length < 2) return;
  const results = $('#results');
  results.classList.remove('hidden');
  results.innerHTML = '<div class="search-loading">Recherche IGN…</div>';
  try {
    const response = await fetch(`${api}/geocode?q=${encodeURIComponent(query)}&limit=6`);
    if (!response.ok) throw new Error('Recherche indisponible');
    const payload = await response.json();
    results.innerHTML = payload.features.length
      ? payload.features.map((place: Place, index: number) => `<button type="button" data-result="${index}"><strong>${place.label}</strong><small>${place.context || place.type}</small></button>`).join('')
      : '<div class="search-loading">Aucun résultat</div>';
    results.querySelectorAll('[data-result]').forEach((button: HTMLButtonElement) => button.addEventListener('click', () => {
      const place = payload.features[Number(button.dataset.result)] as Place;
      $('#search').value = place.label;
      results.classList.add('hidden');
      flyTo(place.longitude, place.latitude);
    }));
  } catch (error) {
    results.innerHTML = `<div class="search-loading error">${String(error)}</div>`;
  }
}

$('#search-form').addEventListener('submit', (event: Event) => {
  event.preventDefault();
  void searchPlaces($('#search').value);
});
$('#search').addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void searchPlaces($('#search').value), 350);
});

document.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-layer]').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  const active = button.dataset.layer!;
  Object.entries(layers).forEach(([name, layer]) => {
    if (layer) layer.visible = name === active;
  });
  view.notifyChange();
}));

function createBBox(): BBox {
  const width = Number($('#width').value);
  const height = Number($('#height').value);
  const latDelta = height / 111_320 / 2;
  const lonDelta = width / (111_320 * Math.max(0.2, Math.cos(center.latitude * Math.PI / 180))) / 2;
  return {
    west: center.longitude - lonDelta,
    south: center.latitude - latDelta,
    east: center.longitude + lonDelta,
    north: center.latitude + latDelta,
  };
}

function updateSelectionBox() {
  if (!selectedBBox) return;
  const width = Number($('#width').value);
  const height = Number($('#height').value);
  const box = $('#selection-box');
  const max = Math.max(width, height);
  box.style.width = `${Math.max(120, width / max * 290)}px`;
  box.style.height = `${Math.max(90, height / max * 240)}px`;
  box.classList.remove('hidden');
}

function displaySelection() {
  if (!selectedBBox) return;
  $('#selection-empty').classList.add('hidden');
  const info = $('#selection-info');
  info.classList.remove('hidden');
  const width = Number($('#width').value);
  const height = Number($('#height').value);
  info.innerHTML = `<div><span>Centre</span><strong>${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}</strong></div><div><span>Surface</span><strong>${(width * height / 10_000).toFixed(1)} ha</strong></div>`;
  updateSelectionBox();
}

async function checkLidar() {
  if (!selectedBBox) return;
  const status = $('#lidar-status');
  status.className = 'status loading';
  status.innerHTML = '<span class="spinner"></span><div><strong>Recherche des dalles…</strong><small>Interrogation du WFS LiDAR HD IGN</small></div>';
  $('#generate').setAttribute('disabled', 'true');
  try {
    const response = await fetch(`${api}/lidar/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selectedBBox),
    });
    const payload = await response.json();
    lidarAvailable = payload.status === 'available';
    const labels: Record<string, [string, string]> = {
      available: ['Données LiDAR disponibles', `${payload.tile_count} dalle(s) intersectent la zone`],
      unavailable: ['Aucune dalle trouvée', 'Modifiez ou réduisez l’emprise'],
      unknown: ['Disponibilité indéterminée', payload.message || 'Le service IGN ne répond pas'],
    };
    const [title, detail] = labels[payload.status] || labels.unknown;
    status.className = `status ${payload.status}`;
    status.innerHTML = `<span class="status-dot"></span><div><strong>${title}</strong><small>${detail}</small></div>`;
    if (lidarAvailable) $('#generate').removeAttribute('disabled');
  } catch {
    lidarAvailable = false;
    status.className = 'status unknown';
    status.innerHTML = '<span class="status-dot"></span><div><strong>Disponibilité indéterminée</strong><small>Erreur de communication avec l’API locale</small></div>';
  }
}

$('#select-zone').addEventListener('click', () => {
  selectedBBox = createBBox();
  displaySelection();
  void checkLidar();
});
['#width', '#height'].forEach(selector => $(selector).addEventListener('input', () => {
  $('#width-value').textContent = `${$('#width').value} m`;
  $('#height-value').textContent = `${$('#height').value} m`;
  if (selectedBBox) {
    selectedBBox = createBBox();
    displaySelection();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void checkLidar(), 500);
  }
}));

$('#collapse').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));

async function updateEstimate() {
  $('#fidelity-value').textContent = `${$('#fidelity').value} %`;
  try {
    const response = await fetch(`${api}/profiles/${$('#profile').value}/estimate?fidelity=${$('#fidelity').value}`);
    const data = await response.json();
    $('#estimate').innerHTML = `<span>RAM estimée <strong>${data.estimated_ram_mb} Mo</strong></span><span>Triangles <strong>${data.estimated_triangles.toLocaleString('fr-FR')}</strong></span>`;
  } catch {
    $('#estimate').textContent = 'Estimation indisponible';
  }
}
$('#fidelity').addEventListener('input', () => void updateEstimate());
$('#profile').addEventListener('change', () => void updateEstimate());
void updateEstimate();

$('#generate').addEventListener('click', async () => {
  if (!selectedBBox || !lidarAvailable) return;
  const modules = Object.fromEntries(
    [...document.querySelectorAll<HTMLInputElement>('[data-module]')].map(input => [input.dataset.module!, input.checked]),
  );
  const name = `zone-${Date.now()}`;
  const response = await fetch(`${api}/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      bbox: selectedBBox,
      profile: $('#profile').value,
      fidelity: Number($('#fidelity').value),
      modules,
    }),
  });
  if (!response.ok) {
    toast('Impossible de démarrer la génération');
    return;
  }
  const job = await response.json();
  $('#progress-wrap').classList.remove('hidden');
  $('#generate').setAttribute('disabled', 'true');
  const poll = window.setInterval(async () => {
    const statusResponse = await fetch(`${api}/generation/${job.id}`);
    const status = await statusResponse.json();
    $('#progress-value').textContent = `${status.progress} %`;
    $('#progress-bar').style.width = `${status.progress}%`;
    $('#progress-message').textContent = status.message;
    $('#progress-label').textContent = status.status === 'completed' ? 'Terminé' : 'Génération';
    if (status.status === 'completed' || status.status === 'failed') {
      window.clearInterval(poll);
      $('#generate').removeAttribute('disabled');
      toast(status.status === 'completed'
        ? 'Carte générée. La prochaine étape reliera le GLB à la scène iTowns.'
        : `Échec : ${status.message}`);
    }
  }, 700);
});
