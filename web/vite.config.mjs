import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // iTowns construit son décodeur LAS avec une URL de worker relative à
  // import.meta.url. L'optimiseur de dépendances Vite déplacerait le module
  // dans node_modules/.vite et casserait cette URL au démarrage du worker.
  // Le laisser servi comme module ESM permet à Vite de transformer et servir
  // correctement lib/Worker/LASLoaderWorker.js.
  optimizeDeps: {
    exclude: ['itowns'],
  },
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      input: {
        map: resolve(webDirectory, 'index.html'),
        lidar: resolve(webDirectory, 'lidar.html'),
      },
    },
  },
});
