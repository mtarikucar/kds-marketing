import { describe, it, expect } from 'vitest';
import {
  NAV_HUBS,
  UNLISTED_DESTINATIONS,
  visibleNav,
  visibleUnlisted,
  findActiveHub,
  findActiveChild,
  splitByTier,
  shouldAutoOpenAdvanced,
  type FeatureKey,
} from './navigation';

/** Entitle only the given feature keys; core (undefined) is always allowed. */
const entitle =
  (...keys: FeatureKey[]) =>
  (feature?: FeatureKey) =>
    feature ? keys.includes(feature) : true;

const childPaths = (hubs: ReturnType<typeof visibleNav>, id: string) =>
  hubs.find((h) => h.id === id)?.children?.map((c) => c.path) ?? [];

describe('visibleNav — surface model, role + entitlement gating', () => {
  it('shows three surfaces plus settings, not fifteen hubs', () => {
    const hubs = visibleNav(NAV_HUBS, {
      isManager: true, isOwner: true, has: () => true, isAgency: false,
    });
    expect(hubs.map((h) => h.id)).toEqual(['home', 'inbox', 'studio', 'settings']);
  });

  it('a core-only REP sees the same four surfaces, thinned to the pages they may open', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: false, has: entitle() });
    // Packaging is the same for everyone; only the CONTENTS differ by role.
    // That is the point of the merge — a rep and an owner no longer navigate
    // two differently-shaped products.
    expect(hubs.map((h) => h.id)).toEqual(['home', 'inbox', 'studio', 'settings']);
    // Retired hubs are gone as HUBS…
    for (const dissolved of [
      'contacts', 'sales', 'calendar', 'tasks', 'voice', 'growth', 'reports',
      'strategy', 'automation', 'payments', 'sites', 'memberships', 'agency',
      'conversations', 'ai',
    ]) {
      expect(hubs.map((h) => h.id)).not.toContain(dissolved);
    }
    // …and their pages are inside a surface, still filtered exactly as before:
    // /inbox (conversationAi), /calls (telephony), /appointments (funnels +
    // managerOnly) and both /voice pages all stay hidden from an unentitled rep.
    // ONE entry since 2026-09-01 (stage 4). The other six are routes and
    // palette destinations, not menu items — see the collapse suite below.
    expect(childPaths(hubs, 'inbox')).toEqual(['/leads']);
    // Growth Studio itself is ungated since 2026-09-01: a rep gets the surface,
    // read-only, so the rail item can never carry a label it will not open.
    expect(childPaths(hubs, 'studio')).toEqual(['/studio', '/reports']);
    expect(childPaths(hubs, 'settings')).toEqual(['/settings/two-factor']);
  });

  it('a manager with NO entitlements still sees the core-but-managerOnly pages', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    expect(childPaths(hubs, 'studio')).toEqual(['/studio', '/reports']);
    const settings = childPaths(hubs, 'settings');
    // Absorbed from the retired Automation hub; /automations is workflows-gated.
    expect(settings).toContain('/trigger-links');
    expect(settings).not.toContain('/automations');
    // Absorbed from the retired Strategy hub (managerOnly, no entitlement).
    expect(settings).toContain('/studio/strategy');
    // Absorbed from the retired Payments hub; /invoices is invoicing-gated.
    expect(settings).toEqual(expect.arrayContaining([
      '/products', '/subscriptions', '/order-forms', '/billing',
    ]));
    expect(settings).not.toContain('/invoices');
    // Sites (funnels) and Courses (memberships module, OFF by default) keep the
    // entitlement gates they carried as hubs.
    expect(settings).not.toContain('/sites');
    expect(settings).not.toContain('/memberships/courses');
  });

  /**
   * The call log is a LOG. You go to it to read what already happened, or to
   * run the Power Dialer down a list — neither is something that arrives with
   * a person attached, which is what the Inbox surface is for. Since the
   * recording and the analysis now open inside the person's own stream, the
   * only reason left to open /calls is the operational one, and that belongs
   * in the gear area beside the other things you administer.
   *
   * It stays a ROUTE (the frozen set above is unchanged, byte for byte) and it
   * keeps its `telephony` gate. This is a menu move, not a deletion.
   */
  it('files the call log under settings, not on the person surface', () => {
    const hubs = visibleNav(NAV_HUBS, {
      isManager: true, isOwner: true, has: () => true, isAgency: false,
    });
    expect(childPaths(hubs, 'settings')).toContain('/calls');
    expect(childPaths(hubs, 'inbox')).not.toContain('/calls');
  });

  it('carries the telephony gate with it rather than leaving it behind', () => {
    const withTelephony = childPaths(
      visibleNav(NAV_HUBS, { isManager: true, has: entitle('telephony') }),
      'settings',
    );
    const without = childPaths(
      visibleNav(NAV_HUBS, { isManager: true, has: entitle() }),
      'settings',
    );
    expect(withTelephony).toContain('/calls');
    expect(without).not.toContain('/calls');
  });

  it('keeps the moved single-page hubs gated on the SAME entitlement they had', () => {
    const paths = (...keys: FeatureKey[]) =>
      childPaths(visibleNav(NAV_HUBS, { isManager: true, has: entitle(...keys) }), 'settings');
    expect(paths('funnels')).toContain('/sites');
    expect(paths('memberships')).toContain('/memberships/courses');
    expect(paths('workflows')).toContain('/automations');
    expect(paths('invoicing')).toContain('/invoices');
  });

  /**
   * `/inbox` and `/leads` render the SAME component with no prop between them
   * (App.tsx MERGED_SURFACE_ROUTES) and have since v2.284.0. Two menu entries
   * for one page is not a choice a user can make correctly, so the menu lists
   * it once — as `/leads`, ungated.
   *
   * The gate did not move to the survivor; it went away, and that is the honest
   * reading rather than an omission. `conversationAi` used to hide `/inbox`
   * from the menu while `/leads` opened the identical surface one line below
   * it, so it never gated anything. The entitlement's real effect on this
   * surface is INSIDE the page (the stream's `gated` signal). Hanging it on the
   * one remaining entry would take the person list, their activities and their
   * record card off the menu of every workspace without it — exactly the
   * regression v2.284.0 was careful to avoid.
   */
  it('lists the person surface ONCE, ungated, at /leads', () => {
    const withAi = childPaths(
      visibleNav(NAV_HUBS, { isManager: true, has: entitle('conversationAi') }),
      'inbox',
    );
    const withoutAi = childPaths(visibleNav(NAV_HUBS, { isManager: true, has: entitle() }), 'inbox');

    // Identical either way: the entitlement no longer decides anything here.
    expect(withAi).toEqual(withoutAi);
    // First, so the rail's hubTarget lands on a page every workspace can open.
    expect(withoutAi[0]).toBe('/leads');
    // ONE entry, not two. The count is the assertion — a second one is exactly
    // how the duplication came back.
    expect(withoutAi.filter((p) => p === '/leads' || p === '/inbox')).toEqual(['/leads']);
    // …and the surface itself is untouched by the entitlement, as before.
    expect(visibleNav(NAV_HUBS, { isManager: true, has: entitle() }).map((h) => h.id)).toContain(
      'inbox',
    );
  });

  /**
   * The bookmark half. `/inbox` is in the frozen 50-path set and in people's
   * bookmarks, so it stays a route AND stays owned by an item — otherwise the
   * chrome forgets which surface you are on the moment you arrive by the old
   * URL, and `findActiveChild` stops resolving for it.
   */
  it('keeps /inbox reachable and resolving, as an alias of the entry that survived', () => {
    expect(findActiveHub(NAV_HUBS, '/inbox')?.id).toBe('inbox');
    // The alias resolves to the CHILD that replaced it, not to some other page.
    expect(findActiveChild(NAV_HUBS, '/inbox')?.path).toBe('/leads');
    expect(findActiveChild(NAV_HUBS, '/leads')?.path).toBe('/leads');
  });

  it('never points an alias at a path no item owns, nor at a second item', () => {
    // An alias is a second door onto an item. Rename the item's path and the
    // alias silently becomes a route with no owner — resolvable by the router,
    // invisible to the chrome. Cheap to assert, impossible to notice otherwise.
    const owned = new Set(
      NAV_HUBS.flatMap((h) => [
        ...(h.path ? [h.path] : []),
        ...(h.children?.map((c) => c.path) ?? []),
      ]),
    );
    const aliases = NAV_HUBS.flatMap((h) => h.children ?? []).flatMap((c) =>
      (c.aliases ?? []).map((a) => ({ alias: a, on: c.path })),
    );
    expect(aliases.length).toBeGreaterThan(0); // the mechanism is in use
    for (const { alias, on } of aliases) {
      expect({ alias, on, ownerExists: owned.has(on) }).toEqual({ alias, on, ownerExists: true });
      // An alias must not ALSO be a listed item, or two entries own one path.
      expect({ alias, listedTwice: owned.has(alias) }).toEqual({ alias, listedTwice: false });
    }
  });

  it('hides the Agency pages from a non-agency workspace (Epic D)', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, isOwner: true, has: entitle() });
    expect(childPaths(hubs, 'settings').some((p) => p.startsWith('/agency/'))).toBe(false);
  });

  it('shows the Agency pages only to an AGENCY workspace OWNER', () => {
    const hubs = visibleNav(NAV_HUBS, {
      isManager: true, isOwner: true, has: entitle(), isAgency: true,
    });
    expect(childPaths(hubs, 'settings').filter((p) => p.startsWith('/agency/'))).toEqual([
      '/agency/locations',
      '/agency/snapshots',
      '/agency/rebilling',
    ]);
  });

  it('hides the Agency pages from a non-OWNER (MANAGER) of an agency workspace', () => {
    // Every /agency/* backend route is @MarketingRoles('OWNER'); a manager who
    // saw the console would only hit 403s. The hub carrying that gate is gone,
    // so the items carry it — this is the test that says the move kept it.
    const hubs = visibleNav(NAV_HUBS, {
      isManager: true, isOwner: false, has: entitle(), isAgency: true,
    });
    expect(childPaths(hubs, 'settings').some((p) => p.startsWith('/agency/'))).toBe(false);
  });
});

describe('navigation — merged destinations have exactly one home (clean cut)', () => {
  /**
   * Every path the sidebar's config OWNS — a listed item's own path, plus any
   * ALIAS it carries.
   *
   * The aliases had to join this sum on 2026-08-30, when `/inbox` stopped being
   * a menu entry of its own and became a second door onto `/leads` (they render
   * the identical component, so two entries were two doors on one room). The
   * FROZEN SET below did not move by one character: `/inbox` is still a route,
   * still bookmarked, still resolved by findActiveHub/findActiveChild. What
   * changed is where the config keeps it, and this line is what keeps the
   * freeze honest about that rather than letting a "collapse the menu" refactor
   * quietly delete a path.
   */
  const allPaths = [
    ...NAV_HUBS.flatMap((h) => [
      ...(h.path ? [h.path] : []),
      ...(h.children?.flatMap((c) => [c.path, ...(c.aliases ?? [])]) ?? []),
    ]),
    /**
     * The UNLISTED destinations count too, as of stage 4 (2026-09-01).
     *
     * Six pages left the Inbox menu that day and stayed routes — which is the
     * whole point of a menu collapse — so a sum built from the hubs alone would
     * have reported six deletions, forcing either a third list of "exceptions"
     * or an edit to the frozen fifty. Both make this assertion weaker.
     *
     * Counting them here is not a loophole, it is the more accurate question.
     * `UNLISTED_DESTINATIONS` is not a graveyard: `useNavCommands` renders it
     * into the command palette under the SAME role and plan gates the sidebar
     * applies (`visibleUnlisted`), and Breadcrumbs names it. A path in neither
     * a hub nor this list is genuinely unreachable except by typing, and that
     * is exactly what the freeze is for.
     */
    ...UNLISTED_DESTINATIONS.map((d) => d.path),
  ];

  /**
   * Every route the sidebar could reach on 2026-08-28, the day BEFORE the
   * 15-hubs-to-3-surfaces repackaging, captured verbatim.
   *
   * The whole premise of that change is that nothing is lost — hubs were
   * retired, their items moved. This is the only assertion that can actually
   * hold it to that: a spot-check of six favourite paths passes happily while a
   * copy-paste drops the seventh, which is precisely the failure mode. Sorted,
   * so a reordering of the file is not a failure; exact, so a deletion is.
   *
   * ADDING a route means adding a line here on purpose. REMOVING one means
   * deleting a page, which is a product decision, not a nav refactor.
   */
  const PATHS_BEFORE_THE_SURFACE_MERGE = [
    '/accounts', '/agency/locations', '/agency/rebilling',
    '/agency/snapshots',
    '/appointments', '/automations', '/billing', '/booking', '/branding',
    '/calendar', '/calls', '/commissions', '/companies', '/documents', '/home',
    '/import', '/inbox', '/installations', '/invoices', '/leads',
    '/memberships/courses', '/opportunities', '/order-forms', '/products',
    '/prospecting', '/reports', '/research', '/segments',
    '/settings/api-keys',
    '/settings/compliance', '/settings/custom-domains', '/settings/custom-fields',
    '/settings/inbound-webhooks', '/settings/mcp-console', '/settings/modules',
    '/settings/roles', '/settings/sending-domains', '/settings/two-factor',
    '/settings/webhooks', '/sites', '/studio', '/studio/strategy',
    '/subscriptions', '/tags', '/targets', '/tasks', '/trigger-links',
    '/users', '/voice', '/voice/ivr',
  ];

  /**
   * Paths the sidebar config has GAINED since that snapshot, each one a
   * deliberate line rather than a drifting baseline.
   *
   * The frozen list above is a photograph of one day and its name says so, so
   * a page that joins the menu later does not belong in it — editing it would
   * make "captured verbatim" a lie and quietly relicense the whole list as
   * something an author may edit to make a test pass. Additions land here
   * instead, and the assertion stays an EXACT equality against the sum: a
   * deletion still fails, and an addition nobody wrote down still fails.
   *
   * `/settings/pipelines` (2026-09-01): already a route in App.tsx and already
   * linked from the `/opportunities` PageHeader, but never a menu entry — so
   * `allPaths`, which is the sidebar's paths and not the router's, genuinely
   * did not contain it. Stage 4 removes `/opportunities` from the menu, which
   * would have made a typed URL the only way to configure the stages every
   * deal moves through. See the item's own comment in navigation.ts.
   *
   * `/dashboard` and `/help` (2026-09-01): NOT new pages and not newly
   * reachable — both have been in `UNLISTED_DESTINATIONS`, and therefore in the
   * command palette, since before the snapshot. They appear here because the
   * sum above now counts that list, which is what stage 4 required. The honest
   * way to record "the question widened" is a line each, not a quiet edit to a
   * photograph of one day.
   */
  /**
   * `/email-templates`, `/reviews` and `/affiliates` (2026-09-01): three pages
   * that were already real routes and had no menu entry ANYWHERE — their only
   * door was a sub-tab of a "More" tab inside Growth Studio's manual-tools
   * mode. Collapsing the Studio into one working screen closed that door, so
   * they were given a home in Settings ("Marketing assets") rather than being
   * left reachable only by a URL somebody would have to already know.
   */
  /**
   * `/settings/ai-models` (2026-09-01): a genuinely NEW page, not a relocation —
   * the workspace-level default image/video model, with each model's price on
   * the option. Added here rather than to the photograph above, per this list's
   * own rule: the frozen fifty is never edited, and an addition nobody wrote
   * down still fails the exact-equality assertion below.
   */
  const PATHS_ADDED_SINCE = [
    '/settings/pipelines', '/dashboard', '/help',
    '/email-templates', '/reviews', '/affiliates',
    '/settings/ai-models',
  ];

  it('keeps every retired hub reachable by route, so nothing is lost', () => {
    expect([...allPaths].sort()).toEqual(
      [...PATHS_BEFORE_THE_SURFACE_MERGE, ...PATHS_ADDED_SINCE].sort(),
    );
  });

  /**
   * The half of the freeze that stage 4 exists to survive. Stated separately
   * because the equality above would also pass if somebody deleted a frozen
   * path AND added one — the counts would still line up under a careless
   * edit that "fixed" both sides at once.
   */
  it('never drops a path that was in the pre-merge snapshot', () => {
    const have = new Set(allPaths);
    expect(PATHS_BEFORE_THE_SURFACE_MERGE.filter((p) => !have.has(p))).toEqual([]);
    expect(PATHS_BEFORE_THE_SURFACE_MERGE).toHaveLength(50);
  });

  /**
   * Reachability, not merely listedness. `/settings/pipelines` was a route
   * whose ONLY door was a button on another page; this asserts the menu now
   * owns a door of its own, and that it is gated the way App.tsx gates the
   * route (requiredRole={MANAGER}) rather than being offered to a rep who
   * would only meet a redirect.
   */
  it('gives /settings/pipelines a Settings entry, manager-gated like its route', () => {
    const settings = NAV_HUBS.find((h) => h.id === 'settings');
    const item = settings?.children?.find((c) => c.path === '/settings/pipelines');
    expect(item).toBeDefined();
    expect(item?.managerOnly).toBe(true);
    expect(childPaths(
      visibleNav(NAV_HUBS, { isManager: false, isOwner: false, has: entitle(), isAgency: false }),
      'settings',
    )).not.toContain('/settings/pipelines');
  });

  /**
   * Stage 4 (2026-09-01): the Inbox hub collapses to ONE entry.
   *
   * Six pages leave the menu and stay routes. WHERE each capability is reached
   * from afterwards is the audit that had to come first: all six are in the
   * command palette under the same gates, and the three the surface embeds
   * carry a link to their own full page from the view that embeds them.
   */
  const DEPARTED_FROM_THE_INBOX_MENU = [
    '/companies', '/opportunities', '/documents', '/calendar', '/appointments', '/tasks',
  ];

  it('leaves the Inbox surface with exactly one entry: the person', () => {
    const hubs = visibleNav(NAV_HUBS, {
      isManager: true, isOwner: true, has: () => true, isAgency: false,
    });
    // The count is the assertion. "Contains /leads" would pass with all nine.
    expect(childPaths(hubs, 'inbox')).toEqual(['/leads']);
  });

  it('keeps every departed page reachable, as an unlisted destination', () => {
    const unlisted = UNLISTED_DESTINATIONS.map((d) => d.path);
    expect(DEPARTED_FROM_THE_INBOX_MENU.filter((p) => !unlisted.includes(p))).toEqual([]);
  });

  /**
   * The gates come WITH them. `UNLISTED_DESTINATIONS` used to be ungated by
   * construction — its own comment said "only add pages every signed-in member
   * may open" — and `/appointments` (funnels + managerOnly) is not one of
   * those. Dropping it in unguarded would have offered a rep a page whose every
   * backend route is `@MarketingRoles('MANAGER')` + `@RequiresFeature`, which
   * is a permission change dressed up as a packaging change.
   */
  it('carries the departed pages gates into the palette, not just their paths', () => {
    const rep = visibleUnlisted({ isManager: false, has: () => true }).map((d) => d.path);
    const unentitled = visibleUnlisted({ isManager: true, has: (f) => !f }).map((d) => d.path);
    const manager = visibleUnlisted({ isManager: true, has: () => true }).map((d) => d.path);

    expect(manager).toContain('/appointments');
    expect(rep).not.toContain('/appointments');
    expect(unentitled).not.toContain('/appointments');
    // …and the ungated five stay offered to everyone, which is the other half:
    // a gate copied onto the wrong item hides a page a rep works in daily.
    for (const open of ['/companies', '/opportunities', '/documents', '/calendar', '/tasks']) {
      expect(rep).toContain(open);
    }
  });

  /**
   * Ses and Telefon Ağacı are channel CONFIGURATION, not daily work — the same
   * class as the call log that moved on 2026-08-31. They move to Settings with
   * both of their gates, and this is the test that says the move kept them.
   */
  it('files Ses and Telefon Ağacı under Settings, with their gates intact', () => {
    const entitled = childPaths(
      visibleNav(NAV_HUBS, { isManager: true, has: entitle('voiceAi') }),
      'settings',
    );
    expect(entitled).toEqual(expect.arrayContaining(['/voice', '/voice/ivr']));
    expect(
      childPaths(visibleNav(NAV_HUBS, { isManager: true, has: entitle('voiceAi') }), 'inbox'),
    ).not.toContain('/voice');

    // Plan gate.
    expect(
      childPaths(visibleNav(NAV_HUBS, { isManager: true, has: entitle() }), 'settings'),
    ).not.toContain('/voice');
    // Role gate.
    expect(
      childPaths(visibleNav(NAV_HUBS, { isManager: false, has: entitle('voiceAi') }), 'settings'),
    ).not.toContain('/voice/ivr');
  });

  it('never lands the same page in two surfaces', () => {
    // The palette dedupes by path and findActiveHub assumes one owner per path,
    // so a page copied into two surfaces would resolve to whichever hub is
    // listed first — silently, and differently in the breadcrumb.
    expect(new Set(allPaths).size).toBe(allPaths.length);
  });

  it('never references a deleted standalone route', () => {
    for (const dead of [
      '/channels', '/snippets', '/offers', '/estimates', '/dialer',
      '/reports/ads', '/reports/performance', '/reports/analytics',
      '/ai/studio', '/ai/agents', '/ai/knowledge', '/personas', '/brand-brain',
      '/brand-kit', '/settings/connections', '/tax-rates', '/coupons',
    ]) {
      expect(allPaths).not.toContain(dead);
    }
  });

  it('keeps the rail to three surfaces, with settings in the gear area', () => {
    // The old ceiling was 16 main hubs with <=6 children each — a cap on how
    // wide the rail could get. The rail is not the scarce thing any more: three
    // surfaces are, and a surface is allowed to be deep because its pages show
    // up in the hub sub-nav (and the palette), not in the rail.
    const mainHubs = NAV_HUBS.filter((h) => (h.area ?? 'main') === 'main');
    expect(mainHubs.map((h) => h.id)).toEqual(['home', 'inbox', 'studio']);
    expect(NAV_HUBS.filter((h) => h.area === 'settings').map((h) => h.id)).toEqual(['settings']);
  });

  it('the Account Center is the ONE connections surface (settings child)', () => {
    const settings = NAV_HUBS.find((h) => h.id === 'settings');
    const paths = settings?.children?.map((c) => c.path) ?? [];
    expect(paths).toContain('/accounts');
    expect(NAV_HUBS.find((h) => h.id === 'accounts')).toBeUndefined(); // no standalone hub
  });

  it('Brand is ONE settings page (kit + brain merged into /branding)', () => {
    const settings = NAV_HUBS.find((h) => h.id === 'settings');
    const paths = settings?.children?.map((c) => c.path) ?? [];
    expect(paths).toContain('/branding');
    expect(paths).not.toContain('/brand-kit');
  });
});

describe('findActiveHub — path → owning hub', () => {
  it('resolves the home surface (the only one with a path of its own)', () => {
    expect(findActiveHub(NAV_HUBS, '/home')?.id).toBe('home');
  });

  it('resolves every page to its new surface (not by URL prefix)', () => {
    // Work — the pages that arrive with a person attached.
    expect(findActiveHub(NAV_HUBS, '/inbox')?.id).toBe('inbox');
    expect(findActiveHub(NAV_HUBS, '/leads')?.id).toBe('inbox');
    // Set up — Ses and Telefon Ağacı joined the call log here in stage 4.
    expect(findActiveHub(NAV_HUBS, '/voice')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/voice/ivr')?.id).toBe('settings');
    // Make & measure.
    expect(findActiveHub(NAV_HUBS, '/reports')?.id).toBe('studio');
    expect(findActiveHub(NAV_HUBS, '/prospecting')?.id).toBe('studio');
    // Set up.
    expect(findActiveHub(NAV_HUBS, '/tags')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/segments')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/settings/custom-fields')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/trigger-links')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/accounts')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/invoices')?.id).toBe('settings');
  });

  it('keeps /studio and /studio/strategy in DIFFERENT surfaces without ambiguity', () => {
    // The one place the merge split a URL prefix across two surfaces. Longest
    // match settles it — and getting this wrong would put the Settings area
    // chrome around Growth Studio, or the app chrome around Strategy.
    expect(findActiveHub(NAV_HUBS, '/studio')?.id).toBe('studio');
    expect(findActiveHub(NAV_HUBS, '/studio/strategy')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/studio?tab=create')?.id).toBeUndefined(); // query is the router's
  });

  it('resolves a detail route to its list page via longest prefix', () => {
    expect(findActiveHub(NAV_HUBS, '/leads/abc-123')?.id).toBe('inbox');
    expect(findActiveHub(NAV_HUBS, '/memberships/courses/42')?.id).toBe('settings');
  });

  it('returns undefined for an unknown path', () => {
    expect(findActiveHub(NAV_HUBS, '/nope')).toBeUndefined();
  });
});

describe('shouldAutoOpenAdvanced — persisted "More" collapse survives reload', () => {
  it('does NOT auto-open on the initial resolution (prev undefined → cold mount / reload)', () => {
    // On reload the active hub id resolves from undefined once entitlements load;
    // that must not count as a navigation, or a persisted collapse snaps open.
    expect(shouldAutoOpenAdvanced(undefined, 'automation', true)).toBe(false);
  });

  it('auto-opens on a genuine in-session navigation INTO an advanced hub', () => {
    expect(shouldAutoOpenAdvanced('home', 'automation', true)).toBe(true);
  });

  it('does not auto-open when navigating into a NON-advanced hub', () => {
    expect(shouldAutoOpenAdvanced('automation', 'home', false)).toBe(false);
  });

  it('does not auto-open when the hub did not change (re-render on the same advanced page)', () => {
    expect(shouldAutoOpenAdvanced('automation', 'automation', true)).toBe(false);
  });
});

/**
 * The precondition MarketingSidebar.tsx:92 depends on and nothing enforced.
 *
 * `hubTarget = h.path ?? h.children?.[0]?.path` runs over the ALREADY-FILTERED
 * hubs, so for a pathless hub the rail item IS its first VISIBLE child. Gate
 * that child for some role and the item silently re-aims: the label stays
 * "Growth Studio" and the link becomes /reports. That is what happened to the
 * studio hub between the surface merge and 2026-09-01, and the only thing that
 * would have caught it was a reader noticing two prose comments.
 *
 * Two exemptions, both because the item cannot mis-label anything. A hub with
 * its own `path` never consults its children. And a `settings`-area hub is the
 * gear at the foot of the rail, whose label is a CATEGORY ("Settings") rather
 * than the name of one page — re-aiming it at whichever page a reader may open
 * is the behaviour that hub wants, not a broken promise. `home`, `inbox` and
 * `studio` all name a specific surface, and all three are covered here.
 */
describe('hubTarget — a pathless hub is its first child, for everyone', () => {
  it('keeps every pathless hub aimed at the SAME first child for the least-privileged reader', () => {
    // The floor: not a manager, not an owner, entitled to nothing. Anyone who
    // can see the hub at all sees at least this much of it.
    const floor = visibleNav(NAV_HUBS, { isManager: false, has: entitle() });

    for (const raw of NAV_HUBS) {
      if (raw.path || raw.area === 'settings' || !raw.children?.length) continue;
      const visible = floor.find((h) => h.id === raw.id);
      if (!visible) continue; // A hub nobody at the floor can see aims at nothing.
      expect([raw.id, visible.children?.[0]?.path]).toEqual([raw.id, raw.children[0].path]);
    }
  });
});

describe('splitByTier — progressive disclosure', () => {
  it('puts all three surfaces in core, leaving nothing behind "More"', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    const { core, advanced } = splitByTier(hubs);
    expect(core.map((h) => h.id)).toEqual(['home', 'inbox', 'studio']);
    // "More" was progressive disclosure for a 15-hub rail. Three surfaces need
    // no disclosure, so the advanced tier is empty by design — the sidebar
    // drops the section rather than rendering an empty toggle.
    expect(advanced).toEqual([]);
  });

  it('still tiers a hub list that HAS advanced hubs (the mechanism is intact)', () => {
    // Asserted on synthetic input: NAV_HUBS no longer exercises this branch, and
    // a split that silently stopped splitting would be invisible above.
    const { core, advanced } = splitByTier([
      { id: 'a', labelKey: 'k', label: 'A', icon: NAV_HUBS[0].icon },
      { id: 'b', labelKey: 'k', label: 'B', icon: NAV_HUBS[0].icon, tier: 'advanced' },
      { id: 'c', labelKey: 'k', label: 'C', icon: NAV_HUBS[0].icon, area: 'settings' },
    ]);
    expect(core.map((h) => h.id)).toEqual(['a']);
    expect(advanced.map((h) => h.id)).toEqual(['b']);
  });

  it('gives a REP the Growth Studio surface itself, not a rail item pointing elsewhere', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    expect(splitByTier(hubs).core.map((h) => h.id)).toContain('studio');
    // Inverted 2026-09-01. `managerOnly` on this child bought no protection —
    // every write on the page is withheld component-side AND MANAGER-gated
    // server-side, and `/studio` is an auth-only route three redirects send
    // reps to anyway. All it bought was a rail item labelled "Growth Studio"
    // that opened Reports, because `hubTarget` reads the FIRST SURVIVING child.
    const repHubs = visibleNav(NAV_HUBS, { isManager: false, has: entitle() });
    expect(childPaths(repHubs, 'studio')[0]).toBe('/studio');
  });

  it('excludes the settings-area hub from both tiers', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    const { core, advanced } = splitByTier(hubs);
    expect([...core, ...advanced].some((h) => h.area === 'settings')).toBe(false);
  });
});
