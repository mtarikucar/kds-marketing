/**
 * Settings > Modules — the entitlement stack, observed end to end.
 *
 * This is the one screen where the whole chain is visible in a single
 * interaction: the catalogue is built from what the PACKAGE entitles
 * (seed-packages.ts → EntitlementsService.entitledModules), the switch writes
 * `Workspace.activatedModules`, the backend intersects the two into one
 * `features` map, and the SPA renders its navigation from exactly that map
 * (`GET /billing/summary` → useEntitlements → visibleNav).
 *
 * What a failure here means, in order of likelihood:
 *   - PATCH /billing/modules stopped persisting, or stopped invalidating the
 *     30s in-process entitlements cache (marketing-billing.controller.ts:128),
 *     so switching a module off changes nothing a user can see;
 *   - visibleNav() stopped gating on `feature`, so a deactivated module keeps
 *     its hub in the rail (and its pages one click away) while its API 403s;
 *   - the trial package changed what it grants, so the catalogue either lists
 *     an add-on nobody can use or hides a capability the customer paid for.
 *
 * No production component was touched for these tests: the switches are
 * addressed by the aria-label ModulesPage already sets, and the navigation by
 * its links' accessible names.
 */
import { test, expect } from './support/fixtures';

/** PATCH the Modules page issues when a switch is flipped. */
const modulesWrite = (url: string, method: string) =>
  url.includes('/billing/modules') && method === 'PATCH';

test('the catalogue lists what the plan entitles — and nothing else', async ({ app }) => {
  await app.goto('/settings/modules');

  await expect(app.getByRole('heading', { name: 'Modüller', level: 1 })).toBeVisible();

  // A fresh workspace is on the 14-day TRIAL, which grants every toggleable
  // module and starts them all ACTIVE (DEFAULT_ACTIVATED_MODULES).
  // `memberships` is the one worth pinning: it used to default OFF, so someone
  // on a plan that includes Courses opened the console, found no Courses, and
  // got no hint that a Settings toggle was what stood in the way.
  await expect(
    app.getByRole('switch', { name: 'Mesajlar & Gelen Kutusu', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(app.getByRole('switch', { name: 'Kurslar', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(app.getByRole('switch', { name: 'Araştırma', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Fax and voice campaigns are `false` on every customer-facing package —
  // each needs a separately purchased NetGSM package upstream, so they arrive
  // only as a WorkspaceAddOn grant. The catalogue renders `entitledModules`,
  // not the full MODULE_META list, so they must be ABSENT rather than off:
  // an unbuyable switch would be a promise the account cannot keep.
  for (const addOnOnly of ['Faks', 'Sesli kampanyalar']) {
    await expect(app.getByRole('switch', { name: addOnOnly, exact: true })).toHaveCount(0);
  }
});

test('switching a module off removes its hub from the sidebar, and back on restores it', async ({
  app,
}) => {
  await app.goto('/settings/modules');

  // The primary hub rail is the FIRST <aside> — inside the Settings area
  // SettingsLayout renders a second one (the settings page list), so a bare
  // `aside` lookup would be ambiguous here.
  const rail = app.locator('aside').first();
  const inboxHub = rail.getByRole('link', { name: 'Gelen Kutusu', exact: true });
  const toggle = app.getByRole('switch', { name: 'Mesajlar & Gelen Kutusu', exact: true });

  await expect(inboxHub).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const off = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggle.click();
  expect((await off).status()).toBe(200);

  // No reload: the rail reads the SAME ['marketing','billing','summary'] query
  // the mutation invalidates, so the menu must react to the write immediately.
  await expect(inboxHub).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // A reload proves the deactivation reached `Workspace.activatedModules` AND
  // that the server-side entitlements cache was invalidated — not that a hub
  // merely vanished from a client-side cache for 30 seconds.
  await app.reload();
  await expect(app.getByRole('heading', { name: 'Modüller', level: 1 })).toBeVisible();
  await expect(inboxHub).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // Turning it back on must be equally live — a one-way door would strand an
  // owner who switched something off to try it out.
  const on = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggle.click();
  expect((await on).status()).toBe(200);

  await expect(inboxHub).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('deactivating a module also drops its page from the Settings menu', async ({ app }) => {
  await app.goto('/settings/modules');

  // Second <aside> = SettingsLayout's page list (the first is the hub rail).
  // This is the per-CHILD gating path in visibleNav (childVisible), a
  // different branch from the per-HUB one the Inbox test covers.
  const settingsNav = app.locator('aside').nth(1);
  const researchLink = settingsNav.getByRole('link', { name: 'AI Araştırma', exact: true });
  const toggle = app.getByRole('switch', { name: 'Araştırma', exact: true });

  await expect(researchLink).toBeVisible();

  const write = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggle.click();
  expect((await write).status()).toBe(200);

  await expect(researchLink).toHaveCount(0);
  // Only the deactivated child leaves. If the whole Settings list emptied out,
  // the assertion above would pass for entirely the wrong reason — and the
  // owner would have locked themselves out of the switch they just used.
  await expect(settingsNav.getByRole('link', { name: 'Modüller', exact: true })).toBeVisible();
});
