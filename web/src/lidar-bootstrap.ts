import * as itowns from 'itowns';
import { parseLocalLasChunk, terminateLocalLasWorker } from './local-las-parser';
import './itowns-complete-tools.css';

declare global {
  interface Window {
    __SIM_ITOWNS__?: {
      view?: any;
      layers: Map<string, any>;
    };
  }
}

// CopcSource conserve une référence vers l'objet LASParser exporté par iTowns.
// On remplace uniquement parseChunk par notre worker Vite local ; tout le reste
// du pipeline COPC, de la couche et du rendu reste celui d'iTowns.
(itowns.LASParser as any).parseChunk = parseLocalLasChunk;

// Enregistre la GlobeView principale et ses couches sans modifier leur
// fonctionnement. Les PlanarView internes des widgets ne remplacent jamais la
// scène principale dans le registre.
window.__SIM_ITOWNS__ = { layers: new Map<string, any>() };
const originalAddLayer = itowns.View.prototype.addLayer;
itowns.View.prototype.addLayer = function trackedAddLayer(layer: any, parentLayer?: any) {
  const runtime = window.__SIM_ITOWNS__;
  if (runtime && (this as any).isGlobeView) {
    runtime.view = this;
    if (layer?.id) runtime.layers.set(layer.id, layer);
  }
  return originalAddLayer.call(this, layer, parentLayer);
} as typeof itowns.View.prototype.addLayer;

window.addEventListener('beforeunload', () => {
  void terminateLocalLasWorker();
});

await import('./lidar-viewer');
await import('./itowns-complete-tools');
