import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        map: resolve(webDirectory, 'index.html'),
        lidar: resolve(webDirectory, 'lidar.html'),
      },
    },
  },
});
