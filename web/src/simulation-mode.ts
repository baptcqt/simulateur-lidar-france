import * as THREE from 'three';
import * as itowns from 'itowns';

import './simulation-mode.css';

type RuntimeState = {
  view?: any;
  layers: Map<string, any>;
};

type ArtifactStatus = 'loading' | 'ready' | 'empty' | 'error';
type DiagnosticMode = 'classification' | 'elevation' | 'intensity' | 'color';
type RenderMode = 'simulation' | DiagnosticMode;

type SceneArtifact = {
  id: string;
  type: string;
  role: string;
  producer?: string;
  label?: string;
  url?: string;
  layerId?: string;
  defaultVisible?: boolean;
  count?: number;
  metadata?: Record<string, unknown>;
};

type ScenePreset = {
  visibleArtifacts?: string[];
  pointMode?: DiagnosticMode;
  pointOpacity?: number;
  pointSize?: number;
  pointBudget?: number;
};

type SceneRun = {
  id: string;
  status: string;
  version?: string;
  artifacts?: string[];
  metrics?: Record<string, unknown>;
};

type SceneManifest = {
  schemaVersion: number;
  selection?: {
    bbox?: Record<string, number>;
    crs?: string;
  };
  runs?: SceneRun[];
  artifacts: SceneArtifact[];
  presets?: Record<string, ScenePreset>;
  profile?: string;
  pointBudgetHint?: number;
  path?: string;
  buildingsPath?: string;
  buildingCount?: number;
};

type BuildingVolume = {
  id: string;
  crs?: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  points?: number;
};

type BuildingPayload = { buildings?: BuildingVolume[] };

export type SceneArtifactHandle = {
  id: string;
  role: string;
  status: ArtifactStatus;
  count?: number;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  dispose(): void;
};

export type SceneArtifactLoader = (
  artifact: SceneArtifact,
  view: any,
) => Promise<SceneArtifactHandle>;

declare global {
  interface Window {
    __SIM_ITOWNS__?: RuntimeState;
    __SIM_SCENE__?: {
      manifest: SceneManifest;
      artifacts: Map<string, SceneArtifactHandle>;
      applyMode(mode: RenderMode): void;
    };
  }
}

const params = new URL(window.location.href).searchParams;
const copcUrl = params.get('copc') ?? '';
const processed = params.get('processed') === '1' || copcUrl.includes('/processed/');
const raw = params.get('raw') === '1' || (!processed && copcUrl.includes('/files/lidar/'));
const profile = params.get('profile') ?? (processed ? 'balanced' : 'brut');
const handles = new Map<string, SceneArtifactHandle>();
const controls = new Map<string, HTMLInputElement>();
const simulationVisibility = new Map<string, boolean>();
const loaderRegistry = new Map<string, SceneArtifactLoader>();
const LAMBERT_93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs';
const POINT_MODES: Record<DiagnosticMode, number> = {
  classification: itowns.PNTS_MODE.CLASSIFICATION,
  elevation: itowns.PNTS_MODE.ELEVATION,
  intensity: itowns.PNTS_MODE.INTENSITY,
  color: itowns.PNTS_MODE.COLOR,
};

let currentMode: RenderMode = 'simulation';
let simulationStyleInitialized = false;

function requireOptional<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function resolveUrl(value: string): string {
  return new URL(value, window.location.origin).toString();
}

function inferredManifestUrl(): string | null {
  const explicit = params.get('manifest');
  if (explicit) return resolveUrl(explicit);
  if (!processed || !copcUrl) return null;
  try {
    const url = new URL(copcUrl, window.location.href);
    url.pathname = url.pathname.replace(/[^/]+$/, 'manifest.json');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function syntheticManifest(payload: Record<string, unknown> = {}): SceneManifest {
  const pointUrl = asString(payload.path) ?? copcUrl;
  const buildingsUrl = asString(payload.buildingsPath) ?? params.get('buildings');
  const buildingCount = asNumber(payload.buildingCount) ?? 0;
  const pointBudget = asNumber(payload.pointBudgetHint) ?? 1_800_000;
  const artifacts: SceneArtifact[] = [
    {
      id: 'points.cleaned',
      type: 'copc',
      role: 'processed-points',
      producer: processed ? 'pdal' : 'source',
      label: processed ? 'Points traités PDAL' : 'Points LiDAR',
      url: pointUrl,
      defaultVisible: true,
      metadata: { pointBudgetHint: pointBudget },
    },
    {
      id: 'terrain.ign',
      type: 'itowns-layer',
      role: 'terrain',
      producer: 'ign',
      label: 'Relief MNT IGN',
      layerId: 'IGN_MNT_HIGHRES',
      defaultVisible: true,
    },
  ];
  if (buildingsUrl) {
    artifacts.push({
      id: 'buildings.pdal',
      type: 'box-mesh-json',
      role: 'buildings',
      producer: 'pdal',
      label: 'Volumes bâtiment PDAL',
      url: buildingsUrl,
      defaultVisible: buildingCount !== 0,
      count: buildingCount,
    });
  }
  const visibleArtifacts = artifacts
    .filter((artifact) => artifact.defaultVisible !== false)
    .map((artifact) => artifact.id);
  return {
    schemaVersion: 1,
    runs: processed ? [{ id: 'pdal', status: 'completed', artifacts: artifacts.map((artifact) => artifact.id) }] : [],
    artifacts,
    presets: {
      simulation: {
        visibleArtifacts,
        pointMode: 'classification',
        pointOpacity: 0.48,
        pointSize: 1.25,
        pointBudget,
      },
    },
    profile,
    pointBudgetHint: pointBudget,
    path: pointUrl,
    buildingsPath: buildingsUrl ?? undefined,
    buildingCount,
  };
}

function normalizeManifest(value: unknown): SceneManifest {
  if (!value || typeof value !== 'object') throw new Error('Le manifeste de scène est invalide.');
  const payload = value as Record<string, unknown>;
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : null;
  if (payload.schemaVersion === 1 && artifacts) {
    const manifest = payload as unknown as SceneManifest;
    if (!manifest.artifacts.every((artifact) => artifact && typeof artifact.id === 'string' && typeof artifact.type === 'string')) {
      throw new Error('Le manifeste contient un artefact invalide.');
    }
    return manifest;
  }
  return syntheticManifest(payload);
}

async function loadManifest(): Promise<{ manifest: SceneManifest; source: string }> {
  const url = inferredManifestUrl();
  if (!url) return { manifest: syntheticManifest(), source: 'compatibilité' };
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { manifest: normalizeManifest(await response.json()), source: url };
  } catch (error) {
    console.warn('[Scène Simulation] Manifeste indisponible, repli compatible', error);
    return { manifest: syntheticManifest(), source: 'compatibilité' };
  }
}

async function waitForView(timeoutMs = 30_000): Promise<any> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const view = window.__SIM_ITOWNS__?.view;
    if (view?.scene && view?.referenceCrs) return view;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  throw new Error('La GlobeView iTowns n’est pas disponible pour la scène Simulation.');
}

async function waitForLayer(id: string, timeoutMs = 30_000): Promise<any> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const layer = window.__SIM_ITOWNS__?.layers.get(id);
    if (layer) return layer;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  throw new Error(`La couche iTowns ${id} est indisponible.`);
}

function layerHandle(artifact: SceneArtifact, layer: any): SceneArtifactHandle {
  return {
    id: artifact.id,
    role: artifact.role,
    status: 'ready',
    count: artifact.count,
    setVisible(visible: boolean): void {
      layer.visible = visible;
      window.__SIM_ITOWNS__?.view?.notifyChange(layer);
    },
    isVisible(): boolean {
      return layer.visible !== false;
    },
    dispose(): void {
      layer.visible = false;
    },
  };
}

async function loadCopcArtifact(artifact: SceneArtifact): Promise<SceneArtifactHandle> {
  return layerHandle(artifact, await waitForLayer('COPC'));
}

async function loadITownsLayerArtifact(artifact: SceneArtifact): Promise<SceneArtifactHandle> {
  if (!artifact.layerId) throw new Error(`L’artefact ${artifact.id} ne précise pas layerId.`);
  return layerHandle(artifact, await waitForLayer(artifact.layerId));
}

function projectedCorner(volume: BuildingVolume, x: number, y: number, z: number, targetCrs: string): THREE.Vector3 {
  const sourceCrs = volume.crs || 'EPSG:2154';
  if (sourceCrs === 'EPSG:2154') itowns.CRS.defs('EPSG:2154', LAMBERT_93);
  return new itowns.Coordinates(sourceCrs, x, y, z).as(targetCrs).toVector3(new THREE.Vector3());
}

function projectedBox(volume: BuildingVolume, targetCrs: string): THREE.Box3 {
  const box = new THREE.Box3().makeEmpty();
  for (const x of [volume.minX, volume.maxX]) {
    for (const y of [volume.minY, volume.maxY]) {
      for (const z of [volume.minZ, volume.maxZ]) {
        box.expandByPoint(projectedCorner(volume, x, y, z, targetCrs));
      }
    }
  }
  return box;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object: any) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material: any) => material.dispose?.());
    else object.material?.dispose?.();
  });
}

async function loadBuildingArtifact(artifact: SceneArtifact, view: any): Promise<SceneArtifactHandle> {
  if (!artifact.url) throw new Error(`L’artefact ${artifact.id} ne fournit pas d’URL.`);
  const response = await fetch(resolveUrl(artifact.url));
  if (!response.ok) throw new Error(`Volumes bâtiment indisponibles (${response.status}).`);
  const payload = await response.json() as BuildingPayload;
  const buildings = (payload.buildings ?? []).filter((building) =>
    [building.minX, building.minY, building.minZ, building.maxX, building.maxY, building.maxZ].every(Number.isFinite));

  const group = new THREE.Group();
  group.name = `SIM_ARTIFACT_${artifact.id}`;
  const faceMaterial = new THREE.MeshBasicMaterial({
    color: 0xd8c59a,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: true,
  });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x5e5543, transparent: true, opacity: 0.85 });

  for (const building of buildings) {
    const box = projectedBox(building, view.referenceCrs);
    const size = box.getSize(new THREE.Vector3());
    if (![size.x, size.y, size.z].every(Number.isFinite) || size.x <= 0 || size.y <= 0 || size.z <= 0) continue;
    const center = box.getCenter(new THREE.Vector3());
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const mesh = new THREE.Mesh(geometry, faceMaterial);
    mesh.position.copy(center);
    mesh.userData = { artifactId: artifact.id, ...building };
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
    edges.position.copy(center);
    group.add(mesh, edges);
  }

  group.visible = artifact.defaultVisible !== false && group.children.length > 0;
  view.scene.add(group);
  view.notifyChange(group);
  const status: ArtifactStatus = group.children.length > 0 ? 'ready' : 'empty';
  return {
    id: artifact.id,
    role: artifact.role,
    status,
    count: buildings.length,
    setVisible(visible: boolean): void {
      group.visible = status === 'ready' && visible;
      view.notifyChange(group);
    },
    isVisible(): boolean {
      return group.visible;
    },
    dispose(): void {
      view.scene.remove(group);
      disposeObject(group);
      view.notifyChange(view.camera3D);
    },
  };
}

export function registerSceneArtifactLoader(type: string, loader: SceneArtifactLoader): void {
  loaderRegistry.set(type, loader);
}

registerSceneArtifactLoader('copc', loadCopcArtifact);
registerSceneArtifactLoader('itowns-layer', loadITownsLayerArtifact);
registerSceneArtifactLoader('box-mesh-json', loadBuildingArtifact);

function artifactControlId(artifact: SceneArtifact): string {
  if (artifact.role === 'processed-points') return 'lidar-visible';
  if (artifact.role === 'terrain') return 'terrain-visible';
  if (artifact.role === 'buildings') return 'buildings-visible';
  return `artifact-${artifact.id.replace(/[^a-z0-9_-]/gi, '-')}`;
}

function artifactLabel(artifact: SceneArtifact, handle: SceneArtifactHandle): string {
  const base = artifact.label ?? artifact.role ?? artifact.id;
  if (handle.status === 'empty') return `${base} — aucun objet`;
  if (handle.status === 'error') return `${base} — erreur`;
  if (handle.count && handle.count > 0) return `${base} (${handle.count.toLocaleString('fr-FR')})`;
  return base;
}

function ensureArtifactControl(artifact: SceneArtifact, handle: SceneArtifactHandle): HTMLInputElement | null {
  const container = requireOptional<HTMLElement>('.layer-switches');
  if (!container) return null;
  const id = artifactControlId(artifact);
  let input = requireOptional<HTMLInputElement>(`#${id}`);
  let label = input?.closest('label') ?? null;
  if (!input) {
    label = document.createElement('label');
    input = document.createElement('input');
    input.id = id;
    input.type = 'checkbox';
    label.appendChild(input);
    container.appendChild(label);
  }
  if (label) {
    label.dataset.artifactId = artifact.id;
    label.dataset.state = handle.status;
    label.replaceChildren(input, document.createTextNode(` ${artifactLabel(artifact, handle)}`));
    label.title = handle.status === 'empty' ? 'Le traitement a réussi mais ne produit aucun objet pour cette sélection.' : '';
  }
  input.disabled = handle.status !== 'ready';
  input.checked = handle.status === 'ready' && handle.isVisible();
  input.addEventListener('change', () => {
    handle.setVisible(input?.checked ?? false);
    if (currentMode === 'simulation') simulationVisibility.set(artifact.id, input?.checked ?? false);
  });
  controls.set(artifact.id, input);
  return input;
}

function syncControl(artifactId: string, handle: SceneArtifactHandle): void {
  const input = controls.get(artifactId);
  if (input) input.checked = handle.status === 'ready' && handle.isVisible();
}

function setPointMode(mode: DiagnosticMode): void {
  const pointLayer = window.__SIM_ITOWNS__?.layers.get('COPC');
  if (!pointLayer) return;
  const value = POINT_MODES[mode];
  pointLayer.mode = value;
  if (pointLayer.material) {
    pointLayer.material.mode = value;
    pointLayer.material.needsUpdate = true;
  }
  window.__SIM_ITOWNS__?.view?.notifyChange(pointLayer);
}

function updatePointControls(pointSize: number, opacity: number, pointBudget: number): void {
  const pointSizeInput = requireOptional<HTMLInputElement>('#lidar-point-size');
  const opacityInput = requireOptional<HTMLInputElement>('#lidar-opacity');
  const budgetInput = requireOptional<HTMLInputElement>('#lidar-point-budget');
  const pointSizeValue = requireOptional<HTMLOutputElement>('#lidar-point-size-value');
  const opacityValue = requireOptional<HTMLOutputElement>('#lidar-opacity-value');
  const budgetValue = requireOptional<HTMLOutputElement>('#lidar-point-budget-value');
  if (pointSizeInput) pointSizeInput.value = String(pointSize);
  if (opacityInput) opacityInput.value = String(opacity);
  if (budgetInput) budgetInput.value = String(pointBudget);
  if (pointSizeValue) pointSizeValue.value = pointSize.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  if (opacityValue) opacityValue.value = `${Math.round(opacity * 100)} %`;
  if (budgetValue) budgetValue.value = `${(pointBudget / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} M`;
}

function applyPointPreset(preset: ScenePreset): void {
  const pointLayer = window.__SIM_ITOWNS__?.layers.get('COPC');
  if (!pointLayer) return;
  const pointSize = preset.pointSize ?? 1.25;
  const opacity = preset.pointOpacity ?? 0.48;
  const pointBudget = preset.pointBudget ?? 1_800_000;
  pointLayer.pointSize = pointSize;
  pointLayer.opacity = opacity;
  pointLayer.pointBudget = pointBudget;
  if (pointLayer.material) {
    pointLayer.material.size = pointSize;
    pointLayer.material.opacity = opacity;
    pointLayer.material.transparent = opacity < 1;
    pointLayer.material.depthTest = true;
    pointLayer.material.depthWrite = false;
    pointLayer.material.needsUpdate = true;
  }
  updatePointControls(pointSize, opacity, pointBudget);
  window.__SIM_ITOWNS__?.view?.notifyChange(pointLayer);
}

function setToolMessage(message: string): void {
  const result = requireOptional<HTMLElement>('#itowns-tool-result');
  if (result) result.textContent = message;
}

function applySimulation(manifest: SceneManifest): void {
  const preset = manifest.presets?.simulation ?? {};
  const visibleByDefault = new Set(preset.visibleArtifacts ?? manifest.artifacts
    .filter((artifact) => artifact.defaultVisible !== false)
    .map((artifact) => artifact.id));
  for (const artifact of manifest.artifacts) {
    const handle = handles.get(artifact.id);
    if (!handle) continue;
    const desired = simulationVisibility.has(artifact.id)
      ? simulationVisibility.get(artifact.id) === true
      : visibleByDefault.has(artifact.id);
    handle.setVisible(desired);
    simulationVisibility.set(artifact.id, desired);
    syncControl(artifact.id, handle);
  }
  setPointMode(preset.pointMode ?? 'classification');
  if (!simulationStyleInitialized) {
    applyPointPreset(preset);
    simulationStyleInitialized = true;
  }
  document.body.dataset.renderMode = 'simulation';
  const ready = [...handles.values()].filter((handle) => handle.status === 'ready' && handle.isVisible()).length;
  setToolMessage(`Simulation active : ${ready} couche(s) issue(s) des traitements sont composées dans la scène.`);
}

function applyDiagnostic(mode: DiagnosticMode, manifest: SceneManifest): void {
  for (const artifact of manifest.artifacts) {
    const handle = handles.get(artifact.id);
    if (!handle) continue;
    if (currentMode === 'simulation') simulationVisibility.set(artifact.id, handle.isVisible());
    if (artifact.role === 'processed-points') handle.setVisible(true);
    else if (artifact.role === 'buildings' || artifact.role.endsWith('-mesh')) handle.setVisible(false);
    syncControl(artifact.id, handle);
  }
  setPointMode(mode);
  document.body.dataset.renderMode = mode;
  const labels: Record<DiagnosticMode, string> = {
    classification: 'Analyse des classes LiDAR',
    elevation: 'Relief technique des points',
    intensity: 'Intensité brute du capteur',
    color: 'Couleurs enregistrées dans le nuage',
  };
  setToolMessage(`${labels[mode]} : les objets reconstruits sont masqués sans être déchargés.`);
}

function applyMode(mode: RenderMode, manifest: SceneManifest): void {
  const previous = currentMode;
  currentMode = mode;
  if (mode === 'simulation') applySimulation(manifest);
  else {
    currentMode = previous;
    applyDiagnostic(mode, manifest);
    currentMode = mode;
  }
}

function renderPipelineStatus(manifest: SceneManifest, source: string, errors: string[]): void {
  const card = requireOptional<HTMLElement>('#pipeline-status-card');
  const target = requireOptional<HTMLElement>('#pipeline-status');
  if (!card || !target) return;
  card.classList.toggle('processed', processed);
  card.classList.toggle('raw', raw);
  card.classList.toggle('warning', errors.length > 0);
  target.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = processed ? 'Scène de traitement composée' : 'Dalle brute de diagnostic';
  const summary = document.createElement('span');
  const completedRuns = (manifest.runs ?? []).filter((run) => run.status === 'completed').map((run) => run.id);
  summary.textContent = processed
    ? `${completedRuns.join(', ') || 'PDAL'} · profil ${profile} · ${handles.size} artefact(s) chargé(s)`
    : 'Aucun post-traitement n’est déclaré pour cette dalle.';
  const origin = document.createElement('span');
  origin.className = 'manifest-origin';
  origin.textContent = source === 'compatibilité' ? 'Manifeste reconstitué depuis les paramètres existants.' : 'Manifeste de scène version 1 chargé.';
  target.append(strong, summary, origin);
  if (errors.length > 0) {
    const warning = document.createElement('span');
    warning.className = 'pipeline-warning';
    warning.textContent = `${errors.length} artefact(s) indisponible(s) : ${errors.join(' · ')}`;
    target.appendChild(warning);
  }
}

async function loadArtifacts(manifest: SceneManifest, view: any): Promise<string[]> {
  const errors: string[] = [];
  for (const artifact of manifest.artifacts) {
    const loader = loaderRegistry.get(artifact.type);
    if (!loader) {
      const handle: SceneArtifactHandle = {
        id: artifact.id,
        role: artifact.role,
        status: 'error',
        setVisible(): void {},
        isVisible(): boolean { return false; },
        dispose(): void {},
      };
      handles.set(artifact.id, handle);
      ensureArtifactControl(artifact, handle);
      errors.push(`${artifact.label ?? artifact.id} : type ${artifact.type} non pris en charge`);
      continue;
    }
    try {
      const handle = await loader(artifact, view);
      handles.set(artifact.id, handle);
      ensureArtifactControl(artifact, handle);
    } catch (error) {
      console.warn(`[Scène Simulation] Échec de ${artifact.id}`, error);
      const handle: SceneArtifactHandle = {
        id: artifact.id,
        role: artifact.role,
        status: 'error',
        setVisible(): void {},
        isVisible(): boolean { return false; },
        dispose(): void {},
      };
      handles.set(artifact.id, handle);
      ensureArtifactControl(artifact, handle);
      errors.push(`${artifact.label ?? artifact.id} : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

async function initializeSimulationScene(): Promise<void> {
  const [{ manifest, source }, view] = await Promise.all([loadManifest(), waitForView()]);
  const errors = await loadArtifacts(manifest, view);
  const select = requireOptional<HTMLSelectElement>('#lidar-render-mode');
  if (!select) throw new Error('Le sélecteur de rendu est introuvable.');
  select.value = processed ? 'simulation' : 'classification';
  select.addEventListener('change', () => applyMode(select.value as RenderMode, manifest));
  window.__SIM_SCENE__ = {
    manifest,
    artifacts: handles,
    applyMode: (mode) => {
      select.value = mode;
      applyMode(mode, manifest);
    },
  };
  applyMode(select.value as RenderMode, manifest);
  renderPipelineStatus(manifest, source, errors);
  window.dispatchEvent(new CustomEvent('simulateur:scene-ready', {
    detail: { schemaVersion: manifest.schemaVersion, artifactIds: [...handles.keys()], errors },
  }));
}

window.addEventListener('beforeunload', () => {
  for (const handle of handles.values()) handle.dispose();
});

void initializeSimulationScene().catch((error: unknown) => {
  console.error('[Scène Simulation]', error);
  setToolMessage(`Scène Simulation indisponible : ${error instanceof Error ? error.message : String(error)}`);
});
