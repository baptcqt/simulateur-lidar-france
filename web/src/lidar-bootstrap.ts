import * as itowns from 'itowns';
import { parseLocalLasChunk, terminateLocalLasWorker } from './local-las-parser';

// CopcSource conserve une référence vers l'objet LASParser exporté par iTowns.
// On remplace uniquement parseChunk par notre worker Vite local ; tout le reste
// du pipeline COPC, de la couche et du rendu reste celui d'iTowns.
(itowns.LASParser as any).parseChunk = parseLocalLasChunk;

window.addEventListener('beforeunload', () => {
  void terminateLocalLasWorker();
});

await import('./lidar-viewer');
