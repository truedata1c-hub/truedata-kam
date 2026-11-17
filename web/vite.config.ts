import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { quasar, transformAssetUrls } from '@quasar/vite-plugin';

export default defineConfig({
  plugins: [vue({ template: { transformAssetUrls } }), quasar()],
  server: { proxy: { '/api': 'http://127.0.0.1:8080', '/sso': 'http://127.0.0.1:8080', '/demo-platform': 'http://127.0.0.1:8080', '/healthz': 'http://127.0.0.1:8080' } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
