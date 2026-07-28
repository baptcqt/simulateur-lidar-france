import { expose, Transfer } from 'threads/worker';
import LASLoader from '@itowns-las-loader';

// Le worker officiel iTowns est difficile à retrouver après la précompilation
// de la dépendance par Vite. Cette entrée locale garde exactement le chargeur
// LAS/LAZ d'iTowns, mais laisse Vite construire une URL de worker stable.
const loader = new LASLoader();

function transferable(attributes) {
  return Object.values(attributes)
    .filter(ArrayBuffer.isView)
    .map((attribute) => attribute.buffer);
}

expose({
  lazPerf(path) {
    loader.lazPerf = path;
  },

  async parseChunk(data, options) {
    const result = await loader.parseChunk(data, options);
    return Transfer(result, transferable(result.attributes));
  },
});
