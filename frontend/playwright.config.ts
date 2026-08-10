import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against a REAL backend on a DEDICATED database (`marketing_e2e`),
 * never the dev DB — see ops/e2e/README.md for `npm run e2e:up`.
 *
 * This config deliberately does NOT start the backend. Booting Nest takes ~2
 * minutes and owns a database; making it a webServer would hide failures
 * behind Playwright's start timeout and silently reuse whatever is listening.
 * globalSetup probes /health and fails with an actionable message instead.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  /**
   * Capped low ON PURPOSE. Login is throttled at 5/60s with a FIVE MINUTE
   * block (marketing-auth.controller.ts:33) — and the block outlasts any
   * in-suite backoff, so tripping it fails the whole run.
   * Budget: 1 login per worker + 1 for the real-UI-login smoke test.
   * 3 workers + 1 = 4 < 5. Raising `workers` requires a shared-session
   * strategy first, not just a bigger number.
   */
  workers: process.env.CI ? 2 : 3,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.E2E_APP_URL ?? 'http://localhost:5173',
    /**
     * Pinned: the app auto-detects locale from navigator.languages
     * (i18n/config.ts) across 5 locales. Without a pin, assertions that touch
     * copy pass or fail depending on the machine's language.
     */
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: process.env.E2E_APP_URL ?? 'http://localhost:5173',
    /**
     * Locally reuse a dev server you already have running; in CI never do —
     * the previous setting reused unconditionally, so a stale Vite from
     * another branch could be tested without any signal.
     */
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_API_URL: process.env.E2E_API_URL ?? 'http://localhost:3101/api',
    },
  },
});
