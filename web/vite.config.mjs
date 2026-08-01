import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // iTowns doit rester précompilé par Vite : son paquet publié contient des
  // imports internes (Core/..., Layer/...) qui ne peuvent pas être servis bruts.
  // Seul le LASLoader est ciblé par un alias pour construire notre worker local.
  resolve: {
    alias: {
      '@itowns-las-loader': resolve(webDirectory, 'node_modules/itowns/lib/Loader/LASLoader.js'),
    },
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
