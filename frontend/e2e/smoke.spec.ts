/**
 * Smoke — the suite's canary.
 *
 * Unlike the previous version, these tests run against a REAL backend and a
 * REAL session. The old dark-mode test asserted a class it had just set
 * itself and never touched app code; it could not fail. What follows either
 * exercises the product or is not here.
 */
import { test, expect } from './support/fixtures';
import { test as base, expect as baseExpect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { APP_URL, OWNER_STATE_FILE } from './support/config';
import type { OwnerState } from './global-setup';

// ── Public surface (no session needed) ──────────────────────────────────────

base('login page renders its form', async ({ page }) => {
  await page.goto(`${APP_URL}/login`);

  await baseExpect(page.locator('h1')).toBeVisible();
  await baseExpect(page.locator('input[type="email"]')).toBeVisible();
  await baseExpect(page.locator('input[type="password"]')).toBeVisible();
  await baseExpect(page.locator('button[type="submit"]')).toBeVisible();
});

base('an unauthenticated deep link is bounced to /login', async ({ page }) => {
  await page.goto(`${APP_URL}/leads`);
  await baseExpect(page).toHaveURL(/\/login/);
});

/**
 * The one test that signs in the way a human does. Kept to a SINGLE occurrence
 * on purpose — see the `workers` note in playwright.config.ts for the 5/60s
 * login budget.
 */
base('signing in through the UI reaches the home screen', async ({ page }) => {
  const saved = JSON.parse(
    fs.readFileSync(path.resolve(OWNER_STATE_FILE), 'utf8'),
  ) as OwnerState;

  await page.goto(`${APP_URL}/login`);
  await page.locator('input[type="email"]').fill(saved.email);
  await page.locator('input[type="password"]').fill(saved.password);
  await page.locator('button[type="submit"]').click();

  // Signing in lands on the command centre, not the KPI board: the product's
  // promise is that you say what you want, not that you read charts and act on
  // them yourself. /dashboard is still routable and linked from here.
  await baseExpect(page).toHaveURL(/\/home/, { timeout: 30_000 });
  await baseExpect(page.getByTestId('command-bar')).toBeVisible();
});

// ── Authenticated surface (fresh workspace per test) ────────────────────────

test('a fresh workspace lands on the dashboard, not the login page', async ({ app }) => {
  const failures: string[] = [];
  app.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) {
      failures.push(`${r.status()} ${r.url()}`);
    }
  });

  await app.goto('/dashboard');

  await expect(app).toHaveURL(/\/dashboard/);
  await expect(app.getByRole('navigation').first()).toBeVisible();
  expect(failures, `server errors during dashboard bootstrap:\n${failures.join('\n')}`).toEqual([]);
});

test('each test gets its own empty workspace', async ({ app, workspace }) => {
  await app.goto('/leads');

  await expect(app).toHaveURL(/\/leads/);
  // A brand-new workspace has no leads; the page must say so rather than
  // showing another test's rows.
  await expect(app.getByText(/henüz lead yok|no leads/i).first()).toBeVisible();
  expect(workspace.id).toMatch(/^[0-9a-f-]{36}$/);
});
