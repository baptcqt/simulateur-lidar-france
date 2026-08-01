import * as itowns from 'itowns';

type CopcLayerLike = {
  id?: string;
  isCopcLayer?: boolean;
  simulationBuildingsUrl?: string;
  simulationProcessed?: boolean;
  simulationProfile?: string;
  source?: {
    url?: string;
    whenReady?: Promise<unknown>;
  };
};

type RuntimeState = {
  view?: any;
  layers: Map<string, any>;
};

declare global {
  interface Window {
    __SIM_ITOWNS__?: RuntimeState;
  }
}

const REDIRECT_FLAG = Symbol.for('simulateur-lidar-france.itowns-copc-standalone');
const viewPrototype = itowns.View.prototype as any;
const isStandaloneViewer = window.location.pathname.endsWith('/lidar.html');
let redirecting = false;

function runtimeState(): RuntimeState {
  if (!window.__SIM_ITOWNS__) window.__SIM_ITOWNS__ = { layers: new Map<string, any>() };
  return window.__SIM_ITOWNS__;
}

function rememberMainView(view: any, layer?: any): void {
  if (isStandaloneViewer) return;
  if (!view?.isGlobeView) return;
  const runtime = runtimeState();
  runtime.view = view;
  if (layer?.id) runtime.layers.set(layer.id, layer);
  window.dispatchEvent(new CustomEvent('simulateur:map-view-ready'));
}

function sceneManifestUrl(sourceUrl: string, layer: CopcLayerLike): string {
  const source = new URL(sourceUrl, window.location.href);
  const manifest = new URL('/lidar/scene-manifest', window.location.origin);
  manifest.searchParams.set('copc', `${source.pathname}${source.search}`);
  if (layer.simulationBuildingsUrl) manifest.searchParams.set('buildings', layer.simulationBuildingsUrl);
  manifest.searchParams.set('profile', layer.simulationProfile || 'balanced');
  return manifest.toString();
}

function openStandaloneViewer(layer: CopcLayerLike): Promise<never> {
  const sourceUrl = layer.source?.url;
  if (!sourceUrl) {
    return Promise.reject(new Error('La couche COPC ne fournit pas d’URL.'));
  }

  if (!redirecting) {
    redirecting = true;
    const target = new URL('/lidar.html', window.location.origin);
    const isProcessed = Boolean(layer.simulationProcessed) || sourceUrl.includes('/processed/');
    target.searchParams.set('copc', sourceUrl);
    target.searchParams.set('label', layer.id || (isProcessed ? 'Zone LiDAR traitée PDAL' : 'Dalle COPC brute'));
    target.searchParams.set(isProcessed ? 'processed' : 'raw', '1');
    if (layer.simulationProfile) {
      target.searchParams.set('profile', layer.simulationProfile);
    }
    if (layer.simulationBuildingsUrl) {
      target.searchParams.set('buildings', layer.simulationBuildingsUrl);
    }
    if (isProcessed) {
      target.searchParams.set('manifest', sceneManifestUrl(sourceUrl, layer));
    }
    window.location.assign(target.toString());
  }

  // Les anciens chargeurs attendent addLayer puis tentent de manipuler une
  // seconde View dans la page cartographique. La navigation remplace désormais
  // cette architecture : on maintient donc la promesse en attente jusqu’au
  // déchargement de la page.
  return new Promise<never>(() => undefined);
}

runtimeState();

if (!isStandaloneViewer && !viewPrototype[REDIRECT_FLAG]) {
  const originalAddLayer = viewPrototype.addLayer;

  viewPrototype.addLayer = async function addLayerWithStandaloneCopc(layer: CopcLayerLike, ...args: unknown[]) {
    rememberMainView(this, layer);
    if (layer?.isCopcLayer) {
      if (layer.source?.whenReady) await layer.source.whenReady;
      return openStandaloneViewer(layer);
    }
    return originalAddLayer.call(this, layer, ...args);
  };

  viewPrototype[REDIRECT_FLAG] = true;
}
