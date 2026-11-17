import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The browser only ever talks to the Vite origin: /api and /media are proxied
 * server-side to the API process, so the same build works behind any preview
 * host without CORS and without hard-coded localhost URLs.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/files': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
