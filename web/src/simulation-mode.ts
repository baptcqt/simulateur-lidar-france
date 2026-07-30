import * as itowns from 'itowns';

import './simulation-mode.css';

type RuntimeState = {
  view?: any;
  layers: Map<string, any>;
};

declare global {
  interface Window {
    __SIM_ITOWNS__?: RuntimeState;
  }
}

const params = new URL(window.location.href).searchParams;
const copcUrl = params.get('copc') ?? '';
const processed = params.get('processed') === '1' || copcUrl.includes('/processed/');
const raw = params.get('raw') === '1' || (!processed && copcUrl.includes('/files/lidar/'));
const profile = params.get('profile') ?? (processed ? 'balanced' : 'brut');

function requireOptional<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function shortFileName(value: string): string {
  try {
    const pathname = new URL(value, window.location.href).pathname;
    return pathname.split('/').filter(Boolean).slice(-3).join('/');
  } catch {
    return value;
  }
}

function setPipelineMessage(): void {
  const card = requireOptional<HTMLElement>('#pipeline-status-card');
  const target = requireOptional<HTMLElement>('#pipeline-status');
  if (!card || !target) return;

  card.classList.toggle('processed', processed);
  card.classList.toggle('raw', raw);

  if (processed) {
    target.innerHTML = `
      <strong>Zone traitée par PDAL</strong>
      <span>Crop de la sélection actif · profil ${profile} · fichier ${shortFileName(copcUrl)}</span>
    `;
    return;
  }

  target.innerHTML = `
    <strong>Dalle brute non cropée</strong>
    <span>Cette vue est utile pour diagnostiquer une dalle locale, mais elle ne représente pas encore le monde généré par PDAL.</span>
  `;
}

async function waitForLayer(id: string, timeoutMs = 30_000): Promise<any | null> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const layer = window.__SIM_ITOWNS__?.layers.get(id);
    if (layer) return layer;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return null;
}

function setCheckbox(id: string, checked: boolean): void {
  const input = requireOptional<HTMLInputElement>(`#${id}`);
  if (input) input.checked = checked;
}

async function applySimulationDefaults(): Promise<void> {
  const [view, pointLayer, orthoLayer, terrainLayer] = await Promise.all([
    waitForView(),
    waitForLayer('COPC'),
    waitForLayer('IGN_ORTHO'),
    waitForLayer('IGN_MNT_HIGHRES'),
  ]);

  if (!view || !pointLayer) return;

  if (processed) {
    document.body.classList.add('simulation-processed');
    if (orthoLayer) {
      orthoLayer.visible = false;
      setCheckbox('ortho-visible', false);
    }
    if (terrainLayer) {
      terrainLayer.visible = true;
      setCheckbox('terrain-visible', true);
    }
    pointLayer.mode = itowns.PNTS_MODE.CLASSIFICATION;
    pointLayer.pointSize = 1.2;
    pointLayer.opacity = 0.72;
    if (pointLayer.material) {
      pointLayer.material.mode = itowns.PNTS_MODE.CLASSIFICATION;
      pointLayer.material.size = 1.2;
      pointLayer.material.opacity = 0.72;
      pointLayer.material.transparent = true;
      pointLayer.material.depthTest = true;
      pointLayer.material.depthWrite = false;
      pointLayer.material.needsUpdate = true;
    }
  } else {
    document.body.classList.add('simulation-raw');
  }

  const select = requireOptional<HTMLSelectElement>('#lidar-render-mode');
  if (select) select.value = 'classification';
  const pointSize = requireOptional<HTMLInputElement>('#lidar-point-size');
  const opacity = requireOptional<HTMLInputElement>('#lidar-opacity');
  if (processed) {
    if (pointSize) pointSize.value = '1.25';
    if (opacity) opacity.value = '0.72';
  }

  view.notifyChange(pointLayer);
  if (orthoLayer) view.notifyChange(orthoLayer);
  if (terrainLayer) view.notifyChange(terrainLayer);
}

async function waitForView(timeoutMs = 30_000): Promise<any | null> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const view = window.__SIM_ITOWNS__?.view;
    if (view?.scene) return view;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return null;
}

function bindRenderModeWarning(): void {
  const select = requireOptional<HTMLSelectElement>('#lidar-render-mode');
  const result = requireOptional<HTMLElement>('#itowns-tool-result');
  if (!select || !result) return;

  select.addEventListener('change', () => {
    if (select.value === 'elevation') {
      result.textContent = 'Relief technique : palette iTowns brute, utile pour contrôler les hauteurs mais pas pour le rendu simulateur.';
    } else if (select.value === 'intensity') {
      result.textContent = 'Intensité brute : information capteur, souvent grise et peu lisible pour générer le monde.';
    } else if (select.value === 'classification' && processed) {
      result.textContent = 'Mode Simulation : zone cropée PDAL, classes LiDAR nettoyées et orthophoto désactivée par défaut.';
    }
  });
}

setPipelineMessage();
bindRenderModeWarning();
void applySimulationDefaults().catch((error: unknown) => {
  console.warn('[Mode simulation PDAL]', error);
});
