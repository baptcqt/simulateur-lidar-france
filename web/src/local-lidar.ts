import * as THREE from 'three';
import * as itowns from 'itowns';

type LocalLidarFile = {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
};

type LocalFilesResponse = { files: LocalLidarFile[] };
type LocalState = 'idle' | 'loading' | 'success' | 'error';
type RenderStats = { points: number; nodes: number };

const apiUrl = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const COPC_METADATA_TIMEOUT_MS = 40_000;
const COPC_LAYER_TIMEOUT_MS = 50_000;
const COPC_RENDER_TIMEOUT_MS = 60_000;

let localView: any = null;
let localControls: any = null;
let localLayer: any = null;
let localActive = false;
let loadSequence = 0;
let localFiles: LocalLidarFile[] = [];
let previousDisabled = new Map<HTMLInputElement | HTMLButtonElement | HTMLSelectElement, boolean>();

function waitForMainInterface(attempt = 0): void {
  const lidarBlock = document.querySelector<HTMLElement>('.lidar-block');
  const mapSurface = document.querySelector<HTMLDivElement>('#map-surface');
  const lidarSurface = document.querySelector<HTMLDivElement>('#lidar-surface');
  if (!lidarBlock || !mapSurface || !lidarSurface) {
    if (attempt < 100) window.setTimeout(() => waitForMainInterface(attempt + 1), 50);
    return;
  }
  initializeLocalLidar(lidarBlock, mapSurface, lidarSurface);
}

function initializeLocalLidar(
  lidarBlock: HTMLElement,
  mapSurface: HTMLDivElement,
  lidarSurface: HTMLDivElement,
): void {
  itowns.LASParser.enableLazPerf('/laz-perf');
  injectStyles();

  const panel = document.createElement('details');
  panel.className = 'local-lidar-panel';
  panel.innerHTML = `
    <summary>Dalles déjà téléchargées</summary>
    <p class="local-lidar-hint">La dalle la plus récente est sélectionnée automatiquement.</p>
    <select id="local-lidar-select" aria-label="Dalle LiDAR téléchargée"></select>
    <button id="open-local-lidar" type="button" disabled>Afficher la dalle enregistrée</button>
    <div class="local-lidar-actions">
      <button id="choose-local-lidar" type="button">Choisir un fichier…</button>
      <button id="open-lidar-folder" type="button">Ouvrir le dossier</button>
    </div>
    <input id="local-lidar-file" type="file" accept=".copc.laz" hidden>
    <div id="local-lidar-status" class="local-lidar-status idle" aria-live="polite">Recherche des fichiers téléchargés…</div>
  `;
  lidarBlock.appendChild(panel);

  const select = panel.querySelector<HTMLSelectElement>('#local-lidar-select');
  const openButton = panel.querySelector<HTMLButtonElement>('#open-local-lidar');
  const chooseButton = panel.querySelector<HTMLButtonElement>('#choose-local-lidar');
  const folderButton = panel.querySelector<HTMLButtonElement>('#open-lidar-folder');
  const fileInput = panel.querySelector<HTMLInputElement>('#local-lidar-file');
  const localStatus = panel.querySelector<HTMLDivElement>('#local-lidar-status');
  const returnMapButton = document.querySelector<HTMLButtonElement>('#return-map');

  if (!select || !openButton || !chooseButton || !folderButton || !fileInput || !localStatus || !returnMapButton) return;

  const setLocalStatus = (state: LocalState, message: string): void => {
    localStatus.className = `local-lidar-status ${state}`;
    localStatus.textContent = message;
  };

  const refresh = async (selectedName?: string): Promise<void> => {
    setLocalStatus('loading', 'Actualisation des dalles téléchargées…');
    const response = await fetchJson<LocalFilesResponse>('/local-lidar/files');
    localFiles = response.files;
    select.replaceChildren();

    if (localFiles.length === 0) {
      const option = document.createElement('option');
      option.textContent = 'Aucune dalle téléchargée';
      option.value = '';
      select.appendChild(option);
      select.disabled = true;
      openButton.disabled = true;
      setLocalStatus('idle', 'Aucune dalle COPC enregistrée dans data\\lidar.');
      return;
    }

    for (const file of localFiles) {
      const option = document.createElement('option');
      option.value = file.name;
      option.textContent = `${file.name} — ${formatBytes(file.sizeBytes)}`;
      select.appendChild(option);
    }
    select.disabled = false;
    const preferred = selectedName && localFiles.some((file) => file.name === selectedName)
      ? selectedName
      : localFiles[0].name;
    select.value = preferred;
    openButton.disabled = false;
    setLocalStatus('success', `${localFiles.length} dalle(s) disponible(s).`);
  };

  const selectedFile = (): LocalLidarFile | null => localFiles.find((file) => file.name === select.value) ?? null;

  const closeLocalView = (): void => {
    loadSequence += 1;
    try {
      localView?.dispose?.(true);
    } catch (error) {
      console.warn('Nettoyage de la dalle locale incomplet', error);
    }
    localView = null;
    localControls = null;
    localLayer = null;
    localActive = false;
    lidarSurface.replaceChildren();
    lidarSurface.hidden = true;
    mapSurface.hidden = false;
    returnMapButton.hidden = true;
    restoreMainControls(panel);
    document.querySelectorAll<HTMLElement>('.map-controls').forEach((section) => section.classList.remove('inactive'));
    const selectionOverlay = document.querySelector<HTMLElement>('#selection-overlay');
    if (selectionOverlay) selectionOverlay.hidden = false;
    window.dispatchEvent(new Event('resize'));
    setMainStatus('Carte IGN active.');
    const file = selectedFile();
    if (file) setMainTileStatus('ready', 'Dalle locale prête', file.name);
  };

  const openFile = async (file: LocalLidarFile): Promise<void> => {
    if (!lidarSurface.hidden && !localActive) {
      throw new Error('Revenez à la carte avant d’ouvrir une dalle locale.');
    }

    const sequence = ++loadSequence;
    setLocalStatus('loading', `Ouverture de ${file.name}…`);
    setMainTileStatus('loading', 'Ouverture de la dalle locale…', file.name);
    const url = new URL(file.path, `${apiUrl}/`).toString();
    await probeCopc(url);

    const source = new itowns.CopcSource({ url, colorDepth: 16 });
    await withTimeout(Promise.resolve(source.whenReady), COPC_METADATA_TIMEOUT_MS, 'Lecture de la dalle locale');
    if (sequence !== loadSequence) throw new Error('Chargement remplacé');

    if (localActive) closeLocalView();
    const activeSequence = ++loadSequence;
    localActive = true;
    saveAndDisableMainControls(panel);
    document.querySelectorAll<HTMLElement>('.map-controls').forEach((section) => section.classList.add('inactive'));
    const selectionOverlay = document.querySelector<HTMLElement>('#selection-overlay');
    if (selectionOverlay) selectionOverlay.hidden = true;
    mapSurface.hidden = true;
    lidarSurface.hidden = false;
    returnMapButton.hidden = false;
    returnMapButton.disabled = false;

    const referenceCrs = source.crs || 'EPSG:2154';
    const view = new itowns.View(referenceCrs, lidarSurface);
    const controls = new itowns.PlanarControls(view);
    view.controls = controls;
    view.renderer.setClearColor(0x202225);

    const layer = new itowns.CopcLayer(`COPC-local-${Date.now()}`, {
      source,
      crs: view.referenceCrs,
      pointBudget: 2_000_000,
      pointSize: 3,
      sseThreshold: 2,
      mode: itowns.PNTS_MODE.ELEVATION,
    });

    localView = view;
    localControls = controls;
    localLayer = layer;

    try {
      await withTimeout(view.addLayer(layer), COPC_LAYER_TIMEOUT_MS, 'Initialisation de la dalle locale');
      focusCopc(view, controls, layer);
      const stats = await waitForPoints(view, layer, activeSequence);
      setLocalStatus('success', `${file.name} — ${stats.points.toLocaleString('fr-FR')} points visibles.`);
      setMainTileStatus('success', 'Dalle locale affichée', `${stats.points.toLocaleString('fr-FR')} points visibles`);
      setMainStatus('La dalle enregistrée est affichée dans iTowns.');
    } catch (error) {
      closeLocalView();
      throw error;
    }
  };

  openButton.addEventListener('click', () => {
    const file = selectedFile();
    if (!file) return;
    void openFile(file).catch((error: unknown) => {
      const message = friendlyError(error);
      setLocalStatus('error', message);
      setMainTileStatus('error', 'Impossible d’ouvrir la dalle locale', message);
      setMainStatus(`Erreur LiDAR : ${message}`);
    });
  });

  chooseButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.copc.laz')) {
      setLocalStatus('error', 'Sélectionnez un fichier portant l’extension .copc.laz.');
      return;
    }

    chooseButton.disabled = true;
    setLocalStatus('loading', `Copie de ${file.name} dans data\\lidar…`);
    void importFile(file)
      .then(async (imported) => {
        await refresh(imported.name);
        await openFile(imported);
      })
      .catch((error: unknown) => {
        setLocalStatus('error', friendlyError(error));
      })
      .finally(() => { chooseButton.disabled = false; });
  });

  folderButton.addEventListener('click', () => {
    folderButton.disabled = true;
    void fetchJson<{ status: string }>('/local-lidar/open-folder', { method: 'POST' })
      .then(() => setLocalStatus('success', 'Le dossier data\\lidar est ouvert dans l’Explorateur Windows.'))
      .catch((error: unknown) => setLocalStatus('error', friendlyError(error)))
      .finally(() => { folderButton.disabled = false; });
  });

  returnMapButton.addEventListener('click', (event) => {
    if (!localActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeLocalView();
  }, true);

  void refresh().catch((error: unknown) => setLocalStatus('error', friendlyError(error)));
}

async function importFile(file: File): Promise<LocalLidarFile> {
  const response = await fetch(`${apiUrl}/local-lidar/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<LocalLidarFile>;
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, init);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: string };
    return body.detail ?? `Erreur HTTP ${response.status}`;
  } catch {
    return `Erreur HTTP ${response.status}`;
  }
}

async function probeCopc(url: string): Promise<void> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-374' } });
  if (response.status !== 206) throw new Error(`Lecture partielle indisponible (${response.status})`);
  const bytes = await response.arrayBuffer();
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 4));
  if (signature !== 'LASF') throw new Error('Le fichier choisi n’est pas un fichier LAS/COPC valide.');
}

function focusCopc(view: any, controls: any, layer: any): void {
  const bbox = layer.root?.bbox;
  if (!bbox) throw new Error('Emprise de la dalle indisponible.');
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

async function waitForPoints(view: any, layer: any, sequence: number): Promise<RenderStats> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < COPC_RENDER_TIMEOUT_MS) {
    if (sequence !== loadSequence) throw new Error('Chargement remplacé');
    let points = 0;
    let nodes = 0;
    const rootObject = layer.group ?? layer.object3d;
    rootObject?.traverse((object: any) => {
      if (!object.isPoints) return;
      nodes += 1;
      points += object.geometry?.getAttribute('position')?.count ?? 0;
    });
    if (points > 0) return { points, nodes };
    view.notifyChange(view.camera3D);
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
  throw new Error('Le décodeur LiDAR n’a produit aucun point visible.');
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

function saveAndDisableMainControls(localPanel: HTMLElement): void {
  previousDisabled.clear();
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.panel input, .panel button, .panel select')
    .forEach((control) => {
      if (localPanel.contains(control) || control.id === 'return-map') return;
      previousDisabled.set(control, control.disabled);
      control.disabled = true;
    });
}

function restoreMainControls(localPanel: HTMLElement): void {
  previousDisabled.forEach((disabled, control) => { control.disabled = disabled; });
  previousDisabled.clear();
  localPanel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')
    .forEach((control) => { control.disabled = false; });
  const openButton = localPanel.querySelector<HTMLButtonElement>('#open-local-lidar');
  const select = localPanel.querySelector<HTMLSelectElement>('#local-lidar-select');
  if (openButton) openButton.disabled = localFiles.length === 0;
  if (select) select.disabled = localFiles.length === 0;
}

function setMainStatus(message: string): void {
  const status = document.querySelector<HTMLElement>('#status');
  if (status) status.textContent = message;
}

function setMainTileStatus(state: string, title: string, detail?: string): void {
  const output = document.querySelector<HTMLElement>('#tile-status');
  if (!output) return;
  output.className = `tile-status ${state}`;
  output.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'state-dot';
  const content = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  content.appendChild(strong);
  if (detail) {
    const small = document.createElement('span');
    small.textContent = detail;
    content.appendChild(small);
  }
  output.append(dot, content);
}

function formatBytes(value: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/délai|temps/i.test(message)) return 'Le chargement a pris trop de temps.';
  if (/décodeur|aucun point/i.test(message)) return 'Le fichier est ouvert, mais aucun point n’a été produit.';
  if (/partielle|206/i.test(message)) return 'Le fichier ne permet pas les lectures partielles nécessaires.';
  return message;
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    .local-lidar-panel { margin-top: 14px; padding-top: 12px; border-top: 1px solid #d7d7d7; }
    .local-lidar-panel summary { cursor: pointer; font-weight: 750; }
    .local-lidar-hint { margin: 9px 0 7px; font-size: .86rem; line-height: 1.35; }
    #local-lidar-select, #open-local-lidar { width: 100%; margin-top: 7px; }
    #local-lidar-select { padding: 9px; border: 1px solid #aaa; border-radius: 6px; background: #fff; }
    .local-lidar-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 7px; }
    .local-lidar-actions button { font-size: .82rem; padding: 8px; }
    .local-lidar-status { margin-top: 8px; padding: 8px; border-radius: 6px; background: #fff; border: 1px solid #ddd; font-size: .83rem; line-height: 1.35; overflow-wrap: anywhere; }
    .local-lidar-status.loading { border-color: #d7ad65; background: #fff9ed; }
    .local-lidar-status.success { border-color: #80b38d; background: #f3faf5; }
    .local-lidar-status.error { border-color: #cf8585; background: #fff3f3; }
  `;
  document.head.appendChild(style);
}

waitForMainInterface();
