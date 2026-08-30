import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Frontend unit tests. Kept separate from vite.config so the production build
// is untouched. Switched to jsdom + RTL for component tests (Radix/shadcn).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    /**
     * `src`, plus the E2E suite's SUPPORT code — the fixtures' helpers are
     * plain functions with real invariants (see e2e/support/workspaceName.ts),
     * and leaving them untested meant a bug there could only be caught by a
     * full Playwright run against a warm database.
     *
     * Deliberately `e2e/support`, not `e2e`: the specs themselves are
     * Playwright tests and must not be collected here. The two runners stay
     * disjoint by extension as well — Playwright takes `*.spec.ts` (see its
     * `testMatch`), vitest takes `*.test.ts` under support/.
     */
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'e2e/support/**/*.test.ts'],
  },
});
