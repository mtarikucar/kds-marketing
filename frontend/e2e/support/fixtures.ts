/**
 * The E2E fixture set. Import `test` and `expect` from here, not from
 * `@playwright/test`, so every spec gets an isolated workspace and an
 * already-authenticated page.
 *
 *   import { test, expect } from './support/fixtures';
 *
 *   test('leads list renders', async ({ app }) => {
 *     await app.goto('/leads');
 *     ...
 *   });
 *
 * Isolation model:
 *   - ONE owner identity per run (globalSetup) — the register route is
 *     throttled at 3/60s with a 10-minute block.
 *   - ONE login per run, captured by globalSetup and shared by every worker —
 *     login is throttled 5/60s with a 5-minute block.
 *   - ONE fresh workspace per test (`workspace` fixture) — unthrottled, and
 *     the reason tests never see each other's data.
 */
import { test as base, expect, APIRequestContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  newApiContext,
  login,
  createWorkspace,
  switchWorkspace,
  AuthSession,
} from './api';
import { seedSession } from './session';
import { OWNER_STATE_FILE, APP_URL } from './config';
import type { OwnerState } from '../global-setup';

export interface WorkspaceContext {
  id: string;
  name: string;
  session: AuthSession;
}

interface Fixtures {
  /** Playwright request context bound to the API origin. */
  api: APIRequestContext;
  /** A workspace created fresh for this test, with a session scoped to it. */
  workspace: WorkspaceContext;
  /** A page that is already signed in to `workspace`. */
  app: Page;
}

interface WorkerFixtures {
  /** The run-wide owner identity, authenticated once in globalSetup. */
  owner: AuthSession;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  owner: [
    // Playwright inspects the parameter list to work out which fixtures a
    // fixture depends on, so it REQUIRES the destructuring pattern here and
    // rejects a plain identifier at runtime. That collides with no-empty-pattern.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const file = path.resolve(OWNER_STATE_FILE);
      if (!fs.existsSync(file)) {
        throw new Error(
          `Missing ${OWNER_STATE_FILE}. globalSetup should have created it — ` +
            `run via "npm run e2e" so the setup phase executes.`,
        );
      }
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as OwnerState;

      // Reuse the session globalSetup captured instead of logging in here.
      // A login per worker spends the 5/60s budget, and the penalty for
      // exceeding it is a FIVE MINUTE block — long enough to fail this run AND
      // the next one, which is exactly what happened when the suite was run
      // twice in quick succession. Access tokens last 8h, comfortably longer
      // than any suite, and sharing one identity is safe because isolation
      // comes from a per-test workspace, not a per-test user.
      if (saved.session?.accessToken) {
        await use(saved.session);
        return;
      }

      // Fallback for a state file written before sessions were cached.
      const ctx = await newApiContext();
      try {
        await use(await login(ctx, saved.email, saved.password));
      } finally {
        await ctx.dispose();
      }
    },
    { scope: 'worker' },
  ],

  // eslint-disable-next-line no-empty-pattern -- see the note on `owner` above
  api: async ({}, use) => {
    const ctx = await newApiContext();
    await use(ctx);
    await ctx.dispose();
  },

  workspace: async ({ owner, api }, use, testInfo) => {
    // Name carries the test title so a leftover row is traceable to its spec.
    const name = `E2E ${testInfo.title}`.slice(0, 110);
    const { id } = await createWorkspace(api, owner.accessToken, name);
    // The JWT pins the active workspace in its `wsp` claim, so the session
    // must be re-minted for the new workspace or every request lands in the
    // owner's original one.
    const session = await switchWorkspace(api, owner.accessToken, id);
    await use({ id, name, session });
  },

  app: async ({ page, workspace }, use) => {
    await seedSession(page, workspace.session);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Route through APP_URL explicitly: baseURL is set too, but being explicit
    // keeps a mis-set baseURL from silently testing another running Vite.
    const goto = page.goto.bind(page);
    page.goto = ((url: string, opts?: Parameters<Page['goto']>[1]) =>
      goto(url.startsWith('http') ? url : `${APP_URL}${url}`, opts)) as Page['goto'];
    await use(page);
  },
});

export { expect };
