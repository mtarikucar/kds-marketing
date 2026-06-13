import { defineConfig } from 'vitest/config';

// Frontend unit tests. Kept separate from vite.config so the production build
// is untouched. Node environment is enough for the pure-logic tests we have
// today (nav gating); switch to jsdom + RTL when component tests arrive.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
