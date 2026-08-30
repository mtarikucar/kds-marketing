import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: 5173,
    /**
     * Transform the app up front instead of on the first request for it.
     *
     * Dev serves ~200 unbundled ES modules per page and compiles each one the
     * first time a browser asks for it. `page.goto` resolves as soon as the
     * HTML lands, so everything after it — the lazy route chunk and its data —
     * is racing whatever budget the caller allows. Cold, with four Playwright
     * workers competing for eight cores, that tail measured 12–16s against a
     * 10s `expect` timeout; warm, the same tail is ~0.4s. The specs that sort
     * first (accounts, automations) always paid it, which is why they looked
     * permanently broken while later tests in the same files passed.
     *
     * `main.tsx` pulls the eager chrome; the page glob covers the lazily
     * imported routes, which are the part a cold server has never seen. Dev
     * only — `vite build` and `vite preview` (what CI runs) are unaffected —
     * and it speeds up an ordinary `npm run dev` for the same reason.
     */
    warmup: {
      clientFiles: ['./src/main.tsx', './src/pages/**/*.tsx'],
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL?.replace(/\/api\/?$/, '') || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },

  envPrefix: ['VITE_'],

  esbuild: {
    // Strip console.* and debugger in production builds (lead/commission
    // data is PII-adjacent; don't leave it in a shared browser console).
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },

  build: {
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('i18next')) return 'i18n';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('react-hook-form') || id.includes('@hookform')) return 'form';
          if (id.includes('zod')) return 'zod';
          return 'vendor';
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
});
