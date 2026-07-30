import * as itowns from 'itowns';

type CopcLayerLike = {
  id?: string;
  isCopcLayer?: boolean;
  simulationBuildingsUrl?: string;
  source?: {
    url?: string;
    whenReady?: Promise<unknown>;
  };
};

const REDIRECT_FLAG = Symbol.for('simulateur-lidar-france.itowns-copc-standalone');
const viewPrototype = itowns.View.prototype as any;
const isStandaloneViewer = window.location.pathname.endsWith('/lidar.html');
let redirecting = false;

function openStandaloneViewer(layer: CopcLayerLike): Promise<never> {
  const sourceUrl = layer.source?.url;
  if (!sourceUrl) {
    return Promise.reject(new Error('La couche COPC ne fournit pas d’URL.'));
  }

  if (!redirecting) {
    redirecting = true;
    const target = new URL('/lidar.html', window.location.origin);
    target.searchParams.set('copc', sourceUrl);
    target.searchParams.set('label', layer.id || 'Dalle COPC');
    if (layer.simulationBuildingsUrl) {
      target.searchParams.set('buildings', layer.simulationBuildingsUrl);
    }
    window.location.assign(target.toString());
  }

  // Les anciens chargeurs attendent addLayer puis tentent de manipuler une
  // seconde View dans la page cartographique. La navigation remplace désormais
  // cette architecture : on maintient donc la promesse en attente jusqu’au
  // déchargement de la page.
  return new Promise<never>(() => undefined);
}

if (!isStandaloneViewer && !viewPrototype[REDIRECT_FLAG]) {
  const originalAddLayer = viewPrototype.addLayer;

  viewPrototype.addLayer = async function addLayerWithStandaloneCopc(layer: CopcLayerLike, ...args: unknown[]) {
    if (layer?.isCopcLayer) {
      if (layer.source?.whenReady) await layer.source.whenReady;
      return openStandaloneViewer(layer);
    }
    return originalAddLayer.call(this, layer, ...args);
  };

  viewPrototype[REDIRECT_FLAG] = true;
}
