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

  // A TAB of 'Plan ve erişim' since 2026-09-04. A switch that REMOVES features
  // belongs with the plan that pays for them, at the end of the list, rather
  // than near the top beside the logo and the timezone.
  await expect(app).toHaveURL(/\/billing\?tab=modules$/);
  await expect(app.getByRole('tab', { name: 'Modüller', selected: true })).toBeVisible();

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

/**
 * The entitlement chain, observed where it is still observable.
 *
 * This test has been re-aimed three times, and every move is the same story:
 * the page it watched stopped being a gated child of the Inbox surface.
 *
 *   - Until 2026-08-30 it watched /inbox (conversationAi). /inbox became an
 *     ALIAS of /leads with no menu entry of its own.
 *   - Until 2026-08-31 it watched /calls (telephony), which moved to Settings.
 *   - Until 2026-09-01 it watched /voice (voiceAi) — which has now moved to
 *     Settings too, beside the call log, because a phone tree is channel
 *     CONFIGURATION and not something that arrives with a person attached.
 *
 * There is nothing left to watch on the Inbox surface, and that is the POINT
 * rather than an inconvenience: stage 4 collapsed it to a single ungated entry.
 * So the observation moves to the Settings list, and the surface's role in this
 * test inverts — it becomes the thing that must NOT change when a module is
 * switched off.
 */
test('switching a module off drops its PAGE from the settings menu — live — and back on restores it', async ({
  app,
}) => {
  await app.goto('/leads');

  // The primary hub rail is the FIRST <aside> — inside the Settings area
  // SettingsLayout renders a second one (the settings page list), so a bare
  // `aside` lookup would be ambiguous there.
  const rail = app.locator('aside').first();
  const inboxSurface = rail.getByRole('link', { name: 'Gelen Kutusu', exact: true });
  // Every route the chrome offers to the gated PAGE, counted wherever it
  // appears. Zero on the Inbox surface as of stage 4.
  const routesToVoice = app.locator('a[href="/voice"]');
  // The page that left this surface before it. Counted here so the move is
  // OBSERVED rather than assumed: a regression putting it back on the Inbox
  // rail would also quietly re-enable a premise this test has abandoned.
  const routesToCalls = app.locator('a[href="/calls"]');
  // And the ONE route to the person surface. /inbox is a bookmark, never a
  // menu entry: a link back to it anywhere in the chrome is the duplication
  // this collapse removed, coming back.
  const routesToInbox = app.locator('a[href="/inbox"]');
  const routesToPeople = app.locator('a[href="/leads"]');

  await expect(inboxSurface).toBeVisible();
  await expect(routesToVoice).toHaveCount(0);
  await expect(routesToCalls).toHaveCount(0);
  await expect(routesToInbox).toHaveCount(0);
  // ONE, where it used to be two. The second was the sub-nav tab, and
  // HubSubNav renders no strip at all for a surface with fewer than two
  // visible children — the same rule that has always kept Home from growing a
  // one-tab strip. The rail item is now the whole Inbox menu.
  await expect(routesToPeople).toHaveCount(1);
  await expect(inboxSurface).toHaveAttribute('href', '/leads');

  await app.goto('/settings/modules');
  const settingsNav = app.locator('aside').nth(1);
  const voiceLink = settingsNav.getByRole('link', { name: 'Sesli AI', exact: true });
  await expect(voiceLink).toBeVisible();

  const toggle = app.getByRole('switch', { name: 'Sesli AI', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const off = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggle.click();
  expect((await off).status()).toBe(200);

  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // No reload: the settings list reads the SAME ['marketing','billing','summary']
  // query the mutation invalidates, so the menu has to tell the truth without
  // one. A menu that needs a refresh to stop offering a deactivated page is a
  // real bug.
  await expect(voiceLink).toHaveCount(0);
  // The phone tree used to be asserted here as a second gated child. It is a
  // TAB of Ses since 2026-09-03, so it is absent from this list whether the
  // module is on or off — an assertion that can no longer fail, which is worse
  // than no assertion. The gate it was testing is the line above: Ses itself
  // leaves, and the tree leaves inside it.
  // Only the deactivated children leave. If the whole list emptied, the two
  // assertions above would pass for entirely the wrong reason — and the owner
  // would have locked themselves out of the switch they just used.
  // Only the deactivated child leaves. The survivors named here have to be
  // pages the switch does NOT gate — naming Ses would assert the presence of
  // the very thing just switched off, and naming Modules or the call log would
  // name entries that are tabs and never in this list at all.
  await expect(settingsNav.getByRole('link', { name: 'Plan ve erişim', exact: true })).toBeVisible();
  await expect(settingsNav.getByRole('link', { name: 'Bağlantılar', exact: true })).toBeVisible();

  // And the person surface is untouched by any of it — one entry, still there.
  await inboxSurface.click();
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();
  await expect(routesToPeople).toHaveCount(1);

  // A fresh boot proves the deactivation reached `Workspace.activatedModules`
  // AND that the server-side entitlements cache was invalidated — not that a
  // link merely vanished from a client-side cache for 30 seconds.
  await app.goto('/settings/modules');
  const toggleBack = app.getByRole('switch', { name: 'Sesli AI', exact: true });
  await expect(toggleBack).toHaveAttribute('aria-checked', 'false');
  await expect(
    app.locator('aside').nth(1).getByRole('link', { name: 'Sesli AI', exact: true }),
  ).toHaveCount(0);

  // Turning it back on must be equally live — a one-way door would strand an
  // owner who switched something off to try it out.
  const on = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggleBack.click();
  expect((await on).status()).toBe(200);

  await expect(toggleBack).toHaveAttribute('aria-checked', 'true');
  await expect(
    app.locator('aside').nth(1).getByRole('link', { name: 'Sesli AI', exact: true }),
  ).toBeVisible();
});

/**
 * Where the call log lives now.
 *
 * /calls moved out of the Inbox surface and into the Settings area on
 * 2026-08-31: it is a LOG plus a bulk dialer, not something that arrives with a
 * person attached, and the reason to open it from a person is gone — a call in
 * someone's stream now opens its own recording and analysis in place.
 *
 * The move is only half done if the page merely ARRIVES in the settings list:
 * an item in no SETTINGS_GROUPS bucket falls into "Other", which is the
 * grab-bag the grouping exists to prevent. So this watches the group heading,
 * not just the link.
 */
test('the call log is a settings page now, filed with the channels — and the phone is ONE entry', async ({ app }) => {
  await app.goto('/settings/modules');

  // Second <aside> = SettingsLayout's page list (the first is the hub rail).
  const settingsNav = app.locator('aside').nth(1);
  // ONE entry for the whole telephone since 2026-09-04: what answers the line,
  // the options it offers, and what it did. The log was a second line here.
  await expect(settingsNav.getByRole('link', { name: 'Sesli AI', exact: true })).toBeVisible();
  await expect(settingsNav.getByRole('link', { name: 'Aramalar', exact: true })).toHaveCount(0);
  // The phone tree stopped being a line of its own on 2026-09-03: recording the
  // greeting and wiring the keypad is one sitting of work, so it is a TAB of
  // Ses. Its route still resolves (navigation.test.ts pins the path set) — it
  // is the LIST it left.
  await expect(
    settingsNav.getByRole('link', { name: 'Sesli Menü (IVR)', exact: true }),
  ).toHaveCount(0);
  // The standalone Telefon group went with it. What is left is the phone as a
  // channel, sitting with the other channels. An item in no group falls into
  // "Diğer", which is why that last assertion carries the weight.
  await expect(settingsNav.getByText('Telefon', { exact: true })).toHaveCount(0);
  await expect(settingsNav.getByText('Kanallar ve alan adları', { exact: true })).toBeVisible();
  await expect(settingsNav.getByText('Diğer', { exact: true })).toHaveCount(0);

  // And it still opens — a menu move, not a route deletion. /calls is in the
  // frozen 50-path set navigation.test.ts pins.
  await app.goto('/calls');
  await expect(app).toHaveURL(/\/voice\?tab=calls$/);
  await expect(app.getByRole('tab', { name: 'Aramalar', selected: true })).toBeVisible();
  // Inside the settings chrome now: MarketingLayout picks the shell from the
  // owning hub's `area`, so the page arrives beside the settings list rather
  // than under the Inbox sub-nav. Two <aside>s is that shell, structurally —
  // the hub rail plus SettingsLayout's own page list.
  await expect(app.locator('aside')).toHaveCount(2);
  // The list entry that owns this page is Ses — the log is a tab of it, not a
  // line of its own. Naming Aramalar here would assert the very thing the merge
  // removed, one screen after asserting it is gone.
  await expect(
    app.locator('aside').nth(1).getByRole('link', { name: 'Sesli AI', exact: true }),
  ).toBeVisible();
});

test('the person surface has ONE menu entry, and both of its routes still open it', async ({
  app,
}) => {
  // /inbox and /leads have rendered the identical page since v2.284.0. The menu
  // listed it twice until 2026-08-30 — a choice nobody could make correctly —
  // and both halves of the fix need saying out loud: the entry is now ONE, and
  // the old URL still works, because it is in people's bookmarks.
  await app.goto('/leads');
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();

  // Exactly one place in the chrome LINKS to it, and nothing links to /inbox.
  // Since stage 4 that place is the rail item (named for the surface, "Gelen
  // Kutusu"); the sub-nav strip that used to carry a second "Kişiler" tab is
  // gone with the other eight entries. The page still says its own name — in
  // the breadcrumb, asserted below.
  await expect(app.locator('a[href="/leads"]')).toHaveCount(1);
  await expect(app.locator('a[href="/inbox"]')).toHaveCount(0);
  await expect(
    app.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Kişiler', { exact: true }),
  ).toBeVisible();
  // The old label is gone with the old entry — a menu that still said "Lead'ler"
  // beside a page headed "Kişiler" would be the naming half of the same split.
  await expect(app.getByRole('link', { name: "Lead'ler", exact: true })).toHaveCount(0);

  // The bookmark: same page, same chrome, and the surface still resolves — the
  // rail item lights up and the breadcrumb names the page, which is what an
  // alias has to keep beyond the router not 404ing.
  await app.goto('/inbox');
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();
  await expect(
    app.locator('aside').first().getByRole('link', { name: 'Gelen Kutusu', exact: true }),
  ).toBeVisible();
  await expect(
    app.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Kişiler', { exact: true }),
  ).toBeVisible();
});

/**
 * Stage 4 (2026-09-01): the Inbox menu collapses to that one entry, and the six
 * pages that leave it keep working.
 *
 * The unit suite pins the CONFIG (navigation.test.ts). Only a browser can say
 * that six routes really mount a page rather than a blank shell, and that each
 * still names itself — which is the exact failure mode this branch has already
 * shipped once, in a view that rendered nothing while 126 jsdom tests stayed
 * green.
 */
test('every page that left the Inbox menu still opens, and still says where it is', async ({
  app,
}) => {
  await app.goto('/leads');
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();

  // None of the departed six is offered anywhere in the chrome any more.
  for (const gone of [
    '/companies', '/opportunities', '/documents', '/calendar', '/appointments', '/tasks',
  ]) {
    await expect(app.locator(`a[href="${gone}"]`), `${gone} left the menu`).toHaveCount(0);
  }

  // A menu collapse, not a route deletion. Each page mounts, and each names
  // itself in the breadcrumb — an unlisted destination that could not say where
  // it was would be a worse loss than the menu entry it gave up.
  const stillOpens: [string, string][] = [
    ['/companies', 'Şirketler'],
    ['/opportunities', 'Satış Hattı'],
    ['/documents', 'Belgeler'],
    ['/calendar', 'Takvim'],
    ['/appointments', 'Randevular'],
    ['/tasks', 'Görevler'],
  ];
  for (const [path, crumb] of stillOpens) {
    await app.goto(path);
    await expect(app.getByRole('heading', { level: 1 }), `${path} must mount a page`).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      app.getByRole('navigation', { name: 'Breadcrumb' }).getByText(crumb, { exact: true }),
      `${path} must still say where it is`,
    ).toBeVisible();
  }
});

/**
 * The door those six pages have left: the command palette, built from the same
 * gated config the sidebar uses.
 *
 * This is the assertion that makes "they left the menu" honest rather than
 * "they were hidden". If `visibleUnlisted` ever stopped being wired into
 * `useNavCommands`, six pages would become reachable only by typing a URL, and
 * nothing else in this repo would notice.
 */
test('the command palette still offers the pages that left the menu', async ({ app }) => {
  await app.goto('/leads');
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();

  await app.keyboard.press('Control+k');
  const palette = app.getByRole('combobox');
  await expect(palette).toBeVisible();
  await palette.fill('Şirketler');

  const hit = app.getByRole('option', { name: /Şirketler/ }).first();
  await expect(hit).toBeVisible();
  await hit.click();

  await expect(app).toHaveURL(/\/companies/);
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
});

test('deactivating a module also drops its TAB from the page that absorbed it', async ({ app }) => {
  /**
   * The per-CHILD gating path, one level down since 2026-09-04.
   *
   * Research used to be its own Settings entry, and switching the module off
   * removed that entry. It is a TAB of Strategy now — a workspace without a
   * strategy is not one with a blank page, it is one whose machinery has
   * nothing to be for — so the same gate has to travel with it.
   *
   * That is the failure a merge causes silently: fold a gated page into an
   * ungated one and the check disappears, leaving a tab that opens on a panel
   * the plan does not include. A shorter list you cannot use is worse than the
   * long one it replaced, so this asserts the gate in a real browser rather
   * than only in the unit tests.
   */
  await app.goto('/settings/modules');
  const toggle = app.getByRole('switch', { name: 'Araştırma', exact: true });

  await app.goto('/studio/strategy');
  const researchTab = app.getByRole('tab', { name: 'Araştırma', exact: true });
  await expect(researchTab).toBeVisible();

  await app.goto('/settings/modules');
  const write = app.waitForResponse((r) => modulesWrite(r.url(), r.request().method()));
  await toggle.click();
  expect((await write).status()).toBe(200);

  await app.goto('/studio/strategy');
  await expect(researchTab).toHaveCount(0);
  // Only the deactivated half leaves. If the whole page emptied out, the
  // assertion above would pass for entirely the wrong reason.
  await expect(app.getByRole('tab', { name: 'Strateji', exact: true })).toBeVisible();

  // And the URL cannot get past the gate either — otherwise it is a decoration
  // anybody who knows the tab name can type around.
  await app.goto('/studio/strategy?tab=research');
  await expect(researchTab).toHaveCount(0);
  await expect(app.getByRole('tab', { name: 'Strateji', selected: true })).toBeVisible();
});
