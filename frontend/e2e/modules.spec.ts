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
 *     its page in the surface's sub-nav (one click away) while its API 403s;
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

test('switching a module off drops its PAGE from the surface — not the surface itself — and back on restores it', async ({
  app,
}) => {
  // Start on the Inbox SURFACE. Since the 2026-08 merge `conversationAi` gates
  // the /inbox PAGE rather than the hub that used to be it, and a page appears
  // in its surface's sub-nav strip — which HubSubNav renders only for the
  // active surface, and never in the Settings area. So a surface page is the
  // only place the gated item is observable. /leads is an ungated page in the
  // same surface, which lets it double as the survival proof below.
  await app.goto('/leads');

  // The primary hub rail is the FIRST <aside> — inside the Settings area
  // SettingsLayout renders a second one (the settings page list), so a bare
  // `aside` lookup would be ambiguous there.
  const rail = app.locator('aside').first();
  const inboxSurface = rail.getByRole('link', { name: 'Gelen Kutusu', exact: true });
  // Every route the chrome offers to the gated PAGE, counted wherever it
  // appears. The rail item counts: a surface with no path of its own targets
  // its first VISIBLE child (hubTarget), so it aims at /inbox exactly while
  // /inbox is visible, and re-aims the moment it is not.
  const routesToInbox = app.locator('a[href="/inbox"]');
  // The surface and the page share a label (both are `nav.inbox`), so this
  // counts BOTH — which is what makes "2 → 1" say that the page went and the
  // surface stayed.
  const namedInbox = app.getByRole('link', { name: 'Gelen Kutusu', exact: true });

  await expect(inboxSurface).toBeVisible();
  await expect(namedInbox).toHaveCount(2); // the surface, plus its page as a tab
  await expect(routesToInbox).toHaveCount(2);

  await app.goto('/settings/modules');
  const toggle = app.getByRole('switch', { name: 'Mesajlar & Gelen Kutusu', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const off = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggle.click();
  expect((await off).status()).toBe(200);

  // No reload — and no navigation either. The rail reads the SAME
  // ['marketing','billing','summary'] query the mutation invalidates, so it has
  // to stop aiming at a page this workspace can no longer open the moment the
  // write lands. A menu that needs a refresh to tell the truth is a real bug.
  await expect(inboxSurface).toHaveAttribute('href', '/leads');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // Click, do not goto: a full load would re-fetch everything from the server
  // and prove nothing about the live cache. This is still the same JS heap
  // that issued the write.
  await inboxSurface.click();
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();

  // The PAGE is gone from the sub-nav, and from the rail's target with it…
  await expect(routesToInbox).toHaveCount(0);
  await expect(namedInbox).toHaveCount(1);
  // …while the SURFACE survives, which is the entire reason the gate hangs on
  // the child. It used to hang on the hub, so switching this one module off
  // took Leads, Pipeline, Calendar and Tasks off the rail with it.
  await expect(inboxSurface).toBeVisible();
  await expect(app.getByRole('link', { name: 'Satış Hattı', exact: true })).toBeVisible();

  // A reload proves the deactivation reached `Workspace.activatedModules` AND
  // that the server-side entitlements cache was invalidated — not that a tab
  // merely vanished from a client-side cache for 30 seconds.
  await app.reload();
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();
  await expect(routesToInbox).toHaveCount(0);
  await expect(inboxSurface).toBeVisible();

  // Turning it back on must be equally live — a one-way door would strand an
  // owner who switched something off to try it out.
  await app.goto('/settings/modules');
  const toggleBack = app.getByRole('switch', { name: 'Mesajlar & Gelen Kutusu', exact: true });
  // Still off after a fresh boot: the switch persisted, not just the menu.
  await expect(toggleBack).toHaveAttribute('aria-checked', 'false');

  const on = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggleBack.click();
  expect((await on).status()).toBe(200);

  await expect(toggleBack).toHaveAttribute('aria-checked', 'true');
  await expect(inboxSurface).toHaveAttribute('href', '/inbox');
  await inboxSurface.click();
  await expect(namedInbox).toHaveCount(2);
  await expect(routesToInbox).toHaveCount(2);
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
