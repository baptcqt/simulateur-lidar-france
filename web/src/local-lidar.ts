import * as itowns from 'itowns';

const apiUrl = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const COPC_METADATA_TIMEOUT_MS = 40_000;
const LAMBERT_93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs';

type LocalLidarFile = {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
};

type LocalFilesResponse = { files: LocalLidarFile[] };
type LocalState = 'idle' | 'loading' | 'success' | 'error';
type Bounds4326 = { minLon: number; minLat: number; maxLon: number; maxLat: number };
type LocalTileSource = {
  file: LocalLidarFile;
  bounds: Bounds4326;
  url: string;
  label: string;
};
type PseudoDownloadJob = {
  id: string;
  status: 'completed';
  phase: 'local-cache';
  filename: string;
  path: string;
  bytesDownloaded: number;
  totalBytes: number;
  error: null;
};

declare global {
  interface Window {
    __SIM_ITOWNS__?: {
      view?: any;
      layers: Map<string, any>;
    };
  }
}

let localFiles: LocalLidarFile[] = [];
let activeLocalTile: LocalTileSource | null = null;
let fetchBridgeInstalled = false;
const pseudoDownloadJobs = new Map<string, PseudoDownloadJob>();

function waitForMainInterface(attempt = 0): void {
  const lidarBlock = document.querySelector<HTMLElement>('.lidar-block');
  if (!lidarBlock) {
    if (attempt < 100) window.setTimeout(() => waitForMainInterface(attempt + 1), 50);
    return;
  }
  initializeLocalLidar(lidarBlock);
}

function initializeLocalLidar(lidarBlock: HTMLElement): void {
  itowns.LASParser.enableLazPerf('/laz-perf');
  itowns.CRS.defs('EPSG:2154', LAMBERT_93);
  injectStyles();
  installLocalFetchBridge();

  const panel = document.createElement('details');
  panel.className = 'local-lidar-panel';
  panel.innerHTML = `
    <summary>Dalles déjà téléchargées</summary>
    <p class="local-lidar-hint">Choisissez une dalle locale pour revenir au flux normal : carte IGN, sélection d’une zone, puis crop/nettoyage PDAL.</p>
    <select id="local-lidar-select" aria-label="Dalle LiDAR téléchargée"></select>
    <button id="open-local-lidar" type="button" disabled>Placer cette dalle sur la carte</button>
    <div class="local-lidar-actions">
      <button id="choose-local-lidar" type="button">Choisir un fichier…</button>
      <button id="open-lidar-folder" type="button">Ouvrir le dossier</button>
    </div>
    <input id="local-lidar-file" type="file" accept=".copc.laz" hidden>
    <div id="local-lidar-status" class="local-lidar-status idle" aria-live="polite">Recherche des fichiers téléchargés…</div>
  `;
  lidarBlock.appendChild(panel);

  const select = requirePanelElement<HTMLSelectElement>(panel, '#local-lidar-select');
  const openButton = requirePanelElement<HTMLButtonElement>(panel, '#open-local-lidar');
  const chooseButton = requirePanelElement<HTMLButtonElement>(panel, '#choose-local-lidar');
  const folderButton = requirePanelElement<HTMLButtonElement>(panel, '#open-lidar-folder');
  const fileInput = requirePanelElement<HTMLInputElement>(panel, '#local-lidar-file');
  const localStatus = requirePanelElement<HTMLDivElement>(panel, '#local-lidar-status');

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

  const activateSelectedFile = async (file: LocalLidarFile): Promise<void> => {
    openButton.disabled = true;
    setLocalStatus('loading', `Lecture de l’emprise de ${file.name}…`);
    setMainTileStatus('loading', 'Lecture de la dalle locale…', 'Préparation de la carte IGN.');
    try {
      const source = await inspectLocalCopc(file);
      activeLocalTile = source;
      pseudoDownloadJobs.clear();
      await focusMapOnLocalTile(source);
      setLocalStatus('success', `${file.name} placée sur la carte. Tracez maintenant une zone à cropper.`);
      setMainTileStatus('ready', 'Dalle locale prête', 'Sélectionnez une zone puis cliquez sur Afficher le LiDAR.');
      setMainStatus('La carte est centrée sur la dalle locale. Le prochain affichage passera par PDAL.');
    } finally {
      openButton.disabled = localFiles.length === 0;
    }
  };

  openButton.addEventListener('click', () => {
    const file = selectedFile();
    if (!file) return;
    void activateSelectedFile(file).catch((error: unknown) => {
      const message = friendlyError(error);
      setLocalStatus('error', message);
      setMainTileStatus('error', 'Dalle locale inutilisable', message);
      setMainStatus(`Erreur dalle locale : ${message}`);
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
        await activateSelectedFile(imported);
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

  void refresh().catch((error: unknown) => setLocalStatus('error', friendlyError(error)));
}

function installLocalFetchBridge(): void {
  if (fetchBridgeInstalled) return;
  fetchBridgeInstalled = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = requestUrlString(input);
    const method = requestMethod(input, init);
    const url = new URL(requestUrl, window.location.origin);

    if (method === 'GET' && url.pathname === '/lidar/tiles' && activeLocalTile) {
      const requestedBounds = parseBbox(url.searchParams.get('bbox'));
      if (requestedBounds && boundsIntersect(activeLocalTile.bounds, requestedBounds)) {
        return jsonResponse(fakeLidarTileResponse(activeLocalTile));
      }
    }

    if (method === 'POST' && url.pathname === '/lidar/downloads' && activeLocalTile) {
      const requestedUrl = await requestBodyUrl(init?.body);
      if (requestedUrl && urlTargetsActiveLocalTile(requestedUrl, activeLocalTile)) {
        const job = createPseudoDownloadJob(activeLocalTile);
        pseudoDownloadJobs.set(job.id, job);
        return jsonResponse(job, 202);
      }
    }

    const downloadMatch = url.pathname.match(/^\/lidar\/downloads\/([^/]+)$/);
    if (method === 'GET' && downloadMatch) {
      const job = pseudoDownloadJobs.get(downloadMatch[1]);
      if (job) return jsonResponse(job);
    }

    return originalFetch(input as RequestInfo, init);
  };
}

function requestUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

async function requestBodyUrl(body: BodyInit | null | undefined): Promise<string | null> {
  if (typeof body !== 'string') return null;
  try {
    const payload = JSON.parse(body) as { url?: string };
    return typeof payload.url === 'string' ? payload.url : null;
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeLidarTileResponse(source: LocalTileSource): { features: unknown[] } {
  const { bounds } = source;
  return {
    features: [{
      type: 'Feature',
      id: `local-${source.file.name}`,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [bounds.minLon, bounds.minLat],
          [bounds.maxLon, bounds.minLat],
          [bounds.maxLon, bounds.maxLat],
          [bounds.minLon, bounds.maxLat],
          [bounds.minLon, bounds.minLat],
        ]],
      },
      properties: {
        name: `Dalle locale — ${source.file.name}`,
        filename: source.file.name,
        source: 'local-cache',
      },
      downloadUrl: source.url,
      isCopc: true,
    }],
  };
}

function createPseudoDownloadJob(source: LocalTileSource): PseudoDownloadJob {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    status: 'completed',
    phase: 'local-cache',
    filename: source.file.name,
    path: source.file.path,
    bytesDownloaded: source.file.sizeBytes,
    totalBytes: source.file.sizeBytes,
    error: null,
  };
}

function urlTargetsActiveLocalTile(value: string, source: LocalTileSource): boolean {
  try {
    const parsed = new URL(value, window.location.href);
    return decodeURI(parsed.pathname) === source.file.path;
  } catch {
    return value === source.url || value === source.file.path;
  }
}

async function inspectLocalCopc(file: LocalLidarFile): Promise<LocalTileSource> {
  const url = new URL(file.path, `${apiUrl}/`).toString();
  await probeCopc(url);
  const source = new itowns.CopcSource({ url, colorDepth: 16 });
  await withTimeout(Promise.resolve(source.whenReady), COPC_METADATA_TIMEOUT_MS, 'Lecture de l’emprise COPC');
  const sourceCrs = normalizeSourceCrs(source, file.name);
  const bounds = boundsFromSourceCube(source, sourceCrs);
  return { file, url, bounds, label: `Dalle locale — ${file.name}` };
}

function normalizeSourceCrs(source: any, label: string): string {
  const upper = label.toUpperCase();
  if (!source.crs && (upper.includes('LAMB93') || upper.includes('IGN69'))) {
    source.crs = 'EPSG:2154';
  }
  if (source.crs === 'EPSG:2154') itowns.CRS.defs('EPSG:2154', LAMBERT_93);
  if (!source.crs) throw new Error('Le système de coordonnées de la dalle locale est introuvable.');
  return source.crs;
}

function boundsFromSourceCube(source: any, sourceCrs: string): Bounds4326 {
  const cube = source.info?.cube;
  if (!Array.isArray(cube) || cube.length < 6 || !cube.slice(0, 6).every(Number.isFinite)) {
    throw new Error('L’emprise de la dalle locale est indisponible.');
  }
  const bounds: Bounds4326 = {
    minLon: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  };
  for (const x of [cube[0], cube[3]]) {
    for (const y of [cube[1], cube[4]]) {
      const coord = new itowns.Coordinates(sourceCrs, x, y, 0).as('EPSG:4326');
      bounds.minLon = Math.min(bounds.minLon, coord.longitude);
      bounds.maxLon = Math.max(bounds.maxLon, coord.longitude);
      bounds.minLat = Math.min(bounds.minLat, coord.latitude);
      bounds.maxLat = Math.max(bounds.maxLat, coord.latitude);
    }
  }
  if (!Object.values(bounds).every(Number.isFinite)) {
    throw new Error('L’emprise de la dalle locale ne peut pas être reprojetée.');
  }
  return bounds;
}

async function focusMapOnLocalTile(source: LocalTileSource): Promise<void> {
  const view = await waitForMapView();
  const center = {
    lon: (source.bounds.minLon + source.bounds.maxLon) / 2,
    lat: (source.bounds.minLat + source.bounds.maxLat) / 2,
  };
  const range = rangeForBounds(source.bounds);
  const flatMode = document.querySelector<HTMLInputElement>('input[name="camera-mode"][value="flat"]')?.checked ?? true;
  await view.controls.lookAtCoordinate({
    coord: new itowns.Coordinates('EPSG:4326', center.lon, center.lat),
    range,
    tilt: flatMode ? 89 : 58,
    heading: 0,
    time: 650,
  });
  view.notifyChange(view.camera3D);
}

async function waitForMapView(timeoutMs = 30_000): Promise<any> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const view = window.__SIM_ITOWNS__?.view;
    if (view?.controls) return view;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error('La carte iTowns principale n’est pas encore disponible.');
}

function parseBbox(value: string | null): Bounds4326 | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  return {
    minLon: Math.min(parts[0], parts[2]),
    minLat: Math.min(parts[1], parts[3]),
    maxLon: Math.max(parts[0], parts[2]),
    maxLat: Math.max(parts[1], parts[3]),
  };
}

function boundsIntersect(left: Bounds4326, right: Bounds4326): boolean {
  return left.minLon <= right.maxLon
    && left.maxLon >= right.minLon
    && left.minLat <= right.maxLat
    && left.maxLat >= right.minLat;
}

function rangeForBounds(bounds: Bounds4326): number {
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const metersPerDegreeLon = 111_320 * Math.cos(centerLat * Math.PI / 180);
  const width = Math.abs(bounds.maxLon - bounds.minLon) * metersPerDegreeLon;
  const height = Math.abs(bounds.maxLat - bounds.minLat) * 110_540;
  return Math.min(9_000, Math.max(650, Math.hypot(width, height) * 1.35));
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

function requirePanelElement<T extends Element>(panel: HTMLElement, selector: string): T {
  const element = panel.querySelector<T>(selector);
  if (!element) throw new Error(`Élément ${selector} introuvable.`);
  return element;
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
  if (/délai|temps/i.test(message)) return 'La lecture de la dalle a pris trop de temps.';
  if (/partielle|206/i.test(message)) return 'Le fichier ne permet pas les lectures partielles nécessaires.';
  if (/coordonnées|emprise|reprojetée/i.test(message)) return message;
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
