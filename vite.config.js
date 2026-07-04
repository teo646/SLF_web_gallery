import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const resolve = p => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: '/SLF_web_gallery/',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    rollupOptions: {
      input: {
        main:    resolve('./index.html'),
        gallery: resolve('./gallery.html'),
        viewer:  resolve('./viewer.html'),
      },
    },
  },
});
