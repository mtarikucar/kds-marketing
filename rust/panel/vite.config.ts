import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The panel is a static bundle the jeeta binary serves from JEETA_PANEL_DIR (normally
// `panel/dist`). Content-hashed files land under `assets/`, which the server caches for good;
// `index.html` is revalidated on every load.
//
// `pnpm dev` proxies the server's own paths to a locally running `jeeta serve`
// (JEETA_PANEL_API, default http://127.0.0.1:8080), so the session cookie stays same-origin.
const api = process.env.JEETA_PANEL_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/healthz': { target: api, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2020',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Libraries change far less often than the panel, so they get their own long-cached
        // files and a panel release re-downloads only its own chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (/react-router|@remix-run/.test(id)) return 'router';
          if (id.includes('@tanstack')) return 'tanstack';
          if (id.includes('i18next')) return 'i18n';
          return 'vendor';
        },
      },
    },
  },
});
