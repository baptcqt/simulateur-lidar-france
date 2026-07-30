import * as THREE from 'three';
import * as itowns from 'itowns';
import { Minimap } from 'itowns/widgets';

type ToolMode = 'none' | 'inspect' | 'measure';
type Runtime = { view?: any; layers: Map<string, any> };

const inspectButton = document.querySelector<HTMLButtonElement>('#tool-inspect');
const measureButton = document.querySelector<HTMLButtonElement>('#tool-measure');
const clearButton = document.querySelector<HTMLButtonElement>('#tool-clear');
const snapshotButton = document.querySelector<HTMLButtonElement>('#tool-snapshot');
const result = document.querySelector<HTMLDivElement>('#itowns-tool-result');
const longitude = document.querySelector<HTMLElement>('#scene-longitude');
const latitude = document.querySelector<HTMLElement>('#scene-latitude');
const altitude = document.querySelector<HTMLElement>('#scene-altitude');
const range = document.querySelector<HTMLElement>('#scene-range');
const tilt = document.querySelector<HTMLElement>('#scene-tilt');
const heading = document.querySelector<HTMLElement>('#scene-heading');

let mode: ToolMode = 'none';
let firstMeasurePoint: THREE.Vector3 | null = null;
let helperGroup: THREE.Group | null = null;
let informationTimer: number | undefined;

function runtime(): Runtime | undefined {
  return window.__SIM_ITOWNS__;
}

function globeView(): any | undefined {
  const view = runtime()?.view;
  return view?.isGlobeView ? view : undefined;
}

function setResult(message: string): void {
  if (result) result.textContent = message;
}

function setMode(nextMode: ToolMode): void {
  mode = nextMode;
  firstMeasurePoint = null;
  inspectButton?.setAttribute('aria-pressed', String(mode === 'inspect'));
  measureButton?.setAttribute('aria-pressed', String(mode === 'measure'));
  inspectButton?.classList.toggle('active', mode === 'inspect');
  measureButton?.classList.toggle('active', mode === 'measure');
  const view = globeView();
  if (view?.domElement) view.domElement.style.cursor = mode === 'none' ? '' : 'crosshair';
  if (mode === 'inspect') setResult('Inspection active : cliquez sur le terrain ou le nuage.');
  if (mode === 'measure') setResult('Mesure active : cliquez sur deux positions successives.');
  if (mode === 'none') setResult('Cliquez sur Inspecter ou Mesurer, puis sur la scène.');
}

function pickingPosition(view: any, event: MouseEvent): THREE.Vector3 | null {
  try {
    const picked = view.getPickingPositionFromDepth(view.eventToViewCoords(event));
    if (!picked || !Number.isFinite(picked.x) || !Number.isFinite(picked.y) || !Number.isFinite(picked.z)) return null;
    return picked.clone ? picked.clone() : new THREE.Vector3(picked.x, picked.y, picked.z);
  } catch {
    return null;
  }
}

function geographicPosition(view: any, position: THREE.Vector3): any {
  return new itowns.Coordinates(view.referenceCrs, position.x, position.y, position.z).as('EPSG:4326');
}

function ensureHelpers(view: any): THREE.Group {
  if (!helperGroup) {
    helperGroup = new THREE.Group();
    helperGroup.name = 'outils-visionneuse-itowns';
    view.scene.add(helperGroup);
  }
  return helperGroup;
}

function addMarker(view: any, position: THREE.Vector3): void {
  const geometry = new THREE.SphereGeometry(1.8, 12, 8);
  const material = new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false });
  const marker = new THREE.Mesh(geometry, material);
  marker.position.copy(position);
  marker.renderOrder = 1000;
  ensureHelpers(view).add(marker);
}

function addMeasureLine(view: any, start: THREE.Vector3, end: THREE.Vector3): void {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 999;
  ensureHelpers(view).add(line);
}

function clearHelpers(): void {
  const view = globeView();
  if (!helperGroup || !view) return;
  helperGroup.traverse((object: any) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material: any) => material.dispose?.());
    else object.material?.dispose?.();
  });
  view.scene.remove(helperGroup);
  helperGroup = null;
  firstMeasurePoint = null;
  view.notifyChange(view.camera3D);
  setResult('Repères et mesures effacés.');
}

function inspectPosition(view: any, position: THREE.Vector3): void {
  const coordinate = geographicPosition(view, position);
  addMarker(view, position);
  view.notifyChange(view.camera3D);
  setResult(`Position : ${coordinate.x.toFixed(6)}°, ${coordinate.y.toFixed(6)}° · altitude ${coordinate.z.toFixed(1)} m.`);
}

function measurePosition(view: any, position: THREE.Vector3): void {
  addMarker(view, position);
  if (!firstMeasurePoint) {
    firstMeasurePoint = position;
    setResult('Premier point enregistré. Cliquez sur le second point.');
  } else {
    addMeasureLine(view, firstMeasurePoint, position);
    const distance3D = firstMeasurePoint.distanceTo(position);
    const vertical = Math.abs(firstMeasurePoint.length() - position.length());
    const horizontal = Math.sqrt(Math.max(0, distance3D ** 2 - vertical ** 2));
    setResult(`Distance 3D : ${distance3D.toFixed(2)} m · horizontale ≈ ${horizontal.toFixed(2)} m · dénivelé ≈ ${vertical.toFixed(2)} m.`);
    firstMeasurePoint = null;
  }
  view.notifyChange(view.camera3D);
}

function installSceneInteraction(view: any): void {
  view.domElement.addEventListener('click', (event: MouseEvent) => {
    if (mode === 'none') return;
    const position = pickingPosition(view, event);
    if (!position) {
      setResult('Aucune surface détectée sous le pointeur.');
      return;
    }
    if (mode === 'inspect') inspectPosition(view, position);
    else measurePosition(view, position);
  });
}

function installMinimap(view: any, orthoLayer: any): void {
  if (!orthoLayer?.source || document.querySelector('#widgets-minimap')) return;
  try {
    const minimapLayer = new itowns.ColorLayer('MINIMAP_IGN_ORTHO', { source: orthoLayer.source });
    new Minimap(view, minimapLayer, {
      position: 'bottom-left',
      size: 170,
      translate: { x: 0, y: -48 },
      cursor: '<span class="minimap-cursor" aria-hidden="true"></span>',
    });
  } catch (error) {
    console.warn('[iTowns] Mini-carte indisponible', error);
  }
}

function updateSceneInformation(view: any): void {
  try {
    const target = view.controls.getCameraTargetPosition();
    const coordinate = geographicPosition(view, target);
    if (longitude) longitude.textContent = `${coordinate.x.toFixed(6)}°`;
    if (latitude) latitude.textContent = `${coordinate.y.toFixed(6)}°`;
    if (altitude) altitude.textContent = `${coordinate.z.toFixed(1)} m`;
    if (range) range.textContent = `${Math.round(view.controls.getRange()).toLocaleString('fr-FR')} m`;
    if (tilt) tilt.textContent = `${view.controls.getTilt().toFixed(1)}°`;
    if (heading) heading.textContent = `${view.controls.getHeading().toFixed(1)}°`;
  } catch {
    // La caméra peut être momentanément indisponible pendant une animation.
  }
}

function installKeyboardShortcuts(view: any): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMode('none');
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key.toLowerCase() === 'r') document.querySelector<HTMLButtonElement>('#view-fit')?.click();
    if (event.key.toLowerCase() === 't') document.querySelector<HTMLButtonElement>('#view-top')?.click();
    if (event.key === '3') document.querySelector<HTMLButtonElement>('#view-3d')?.click();
  });
}

function takeSnapshot(view: any): void {
  try {
    view.notifyChange(view.camera3D);
    const canvas = view.renderer?.domElement ?? view.mainLoop?.gfxEngine?.renderer?.domElement;
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Canvas WebGL introuvable.');
    const link = document.createElement('a');
    link.download = `itowns-lidar-${new Date().toISOString().replaceAll(':', '-')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    setResult('Capture PNG créée.');
  } catch (error) {
    setResult(`Capture impossible : ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForGlobeView(): Promise<{ view: any; orthoLayer: any }> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const store = runtime();
    const view = store?.view;
    const orthoLayer = store?.layers.get('IGN_ORTHO');
    if (view?.isGlobeView && orthoLayer) return { view, orthoLayer };
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error('La GlobeView iTowns n’a pas été exposée aux outils.');
}

async function initializeCompleteTools(): Promise<void> {
  if (!inspectButton || !measureButton || !clearButton || !snapshotButton) return;
  const { view, orthoLayer } = await waitForGlobeView();

  installMinimap(view, orthoLayer);
  installSceneInteraction(view);
  installKeyboardShortcuts(view);

  inspectButton.addEventListener('click', () => setMode(mode === 'inspect' ? 'none' : 'inspect'));
  measureButton.addEventListener('click', () => setMode(mode === 'measure' ? 'none' : 'measure'));
  clearButton.addEventListener('click', clearHelpers);
  snapshotButton.addEventListener('click', () => takeSnapshot(view));

  if (informationTimer !== undefined) window.clearInterval(informationTimer);
  updateSceneInformation(view);
  informationTimer = window.setInterval(() => updateSceneInformation(view), 300);
}

window.addEventListener('beforeunload', () => {
  if (informationTimer !== undefined) window.clearInterval(informationTimer);
});

void initializeCompleteTools().catch((error) => {
  console.error('[Outils complets iTowns]', error);
  setResult(error instanceof Error ? error.message : String(error));
});
