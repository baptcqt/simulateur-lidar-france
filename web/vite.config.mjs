import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        map: resolve(import.meta.dirname, 'index.html'),
        lidar: resolve(import.meta.dirname, 'lidar.html'),
      },
    },
  },
});
