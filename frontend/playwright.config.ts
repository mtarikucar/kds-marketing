import { defineConfig, devices } from '@playwright/test';
import * as os from 'node:os';

/**
 * E2E runs against a REAL backend on a DEDICATED database (`marketing_e2e`),
 * never the dev DB — see ops/e2e/README.md for `npm run e2e:up`.
 *
 * This config deliberately does NOT start the backend. Booting Nest takes ~2
 * minutes and owns a database; making it a webServer would hide failures
 * behind Playwright's start timeout and silently reuse whatever is listening.
 * globalSetup probes /health and fails with an actionable message instead.
 */
/**
 * Parallelism for a LOCAL run, sized from the host's cores. See `workers`.
 * `availableParallelism` respects container/cgroup limits where the raw cpu
 * count does not; it landed in Node 18.14, hence the fallback.
 */
function localWorkers(): number {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(2, Math.min(4, Math.floor(cores / 4)));
}

export default defineConfig({
  testDir: './e2e',
  /**
   * Specs are `*.spec.ts`; `*.test.ts` under `e2e/support` belongs to vitest
   * (the fixtures' pure helpers — see vitest.config.ts). Without this, the
   * default testMatch collects BOTH extensions and Playwright would try to run
   * a vitest file as a spec.
   */
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  /**
   * Login is throttled 5/60s with a FIVE MINUTE block
   * (marketing-auth.controller.ts:33), and that block outlasts any in-suite
   * backoff. Workers used to authenticate individually, which put the budget
   * one careless re-run away from locking the suite out — running it twice in
   * a row did exactly that.
   * globalSetup now authenticates ONCE and shares the session, so the whole
   * run costs 2 logins (setup + the real-UI-login smoke test) regardless of
   * worker count, and this number is free to track the machine.
   *
   * So it now DOES track the machine, instead of being the flat 4 that
   * everyone inherited. A worker is not one thread: it drives a whole Chromium
   * (itself multi-process), and locally it competes with a Vite dev server
   * compiling ~200 modules per page AND the Nest API under test — all on the
   * same box. On an 8-core machine the flat 4 over-subscribed it badly enough
   * that a page needed 12-16s to finish rendering against a 10s `expect`
   * budget, and the suite failed 1-5 tests per run with the victims moving
   * around (contention, not a bug in any of them). It was not even buying
   * speed: measured on 8 cores, workers 4 and 2 both completed the full suite
   * in 1.8 minutes — 4 spent the difference thrashing — and only 2 completed
   * it green, repeatably.
   *
   * ~4 cores per worker leaves that headroom. Clamped to at least 2 so a small
   * machine still runs in parallel, and to at most 4 so a big one does not
   * reintroduce the pile-up by driving eight browsers at one dev server.
   *
   * CI is untouched: it serves a PRODUCTION build (see webServer below), which
   * does no on-demand compiling, and its runners are small.
   */
  workers: process.env.CI ? 2 : localWorkers(),

  // `list` for a readable log, `html` for the artifact CI uploads on failure.
  reporter: [['list'], ['html', { open: 'never' }]],
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
    /**
     * CI serves the PRODUCTION build; locally the dev server.
     *
     * The dev bundle never exercises the tsc gate, the chunking, or the
     * esbuild console-drop that actually ships — so a CI suite running against
     * `vite dev` can be fully green while the built app is broken.
     */
    command: process.env.CI
      ? 'npm run build && npm run preview -- --port 5173 --strictPort'
      : 'npm run dev -- --port 5173 --strictPort',
    url: process.env.E2E_APP_URL ?? 'http://localhost:5173',
    /**
     * Locally reuse a dev server you already have running; in CI never do —
     * the previous setting reused unconditionally, so a stale Vite from
     * another branch could be tested without any signal.
     */
    reuseExistingServer: !process.env.CI,
    // CI has to compile the bundle first (tsc + vite build), which is minutes,
    // not seconds — the dev server's 2-minute budget would time out on the
    // build rather than on anything real.
    timeout: process.env.CI ? 420_000 : 120_000,
    env: {
      VITE_API_URL: process.env.E2E_API_URL ?? 'http://localhost:3101/api',
    },
  },
});
