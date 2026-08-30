import { describe, it, expect } from 'vitest';
import {
  NAV_HUBS,
  visibleNav,
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
    expect(childPaths(hubs, 'inbox')).toEqual([
      '/leads', '/companies', '/opportunities', '/documents', '/calendar', '/tasks',
    ]);
    // Growth Studio itself is managerOnly, so a rep's Studio surface is Reports.
    expect(childPaths(hubs, 'studio')).toEqual(['/reports']);
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
  const allPaths = NAV_HUBS.flatMap((h) => [
    ...(h.path ? [h.path] : []),
    ...(h.children?.flatMap((c) => [c.path, ...(c.aliases ?? [])]) ?? []),
  ]);

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
    '/accounts', '/agency/locations', '/agency/rebilling', '/agency/snapshots',
    '/appointments', '/automations', '/billing', '/booking', '/branding',
    '/calendar', '/calls', '/commissions', '/companies', '/documents', '/home',
    '/import', '/inbox', '/installations', '/invoices', '/leads',
    '/memberships/courses', '/opportunities', '/order-forms', '/products',
    '/prospecting', '/reports', '/research', '/segments', '/settings/api-keys',
    '/settings/compliance', '/settings/custom-domains', '/settings/custom-fields',
    '/settings/inbound-webhooks', '/settings/mcp-console', '/settings/modules',
    '/settings/roles', '/settings/sending-domains', '/settings/two-factor',
    '/settings/webhooks', '/sites', '/studio', '/studio/strategy',
    '/subscriptions', '/tags', '/targets', '/tasks', '/trigger-links',
    '/users', '/voice', '/voice/ivr',
  ];

  it('keeps every retired hub reachable by route, so nothing is lost', () => {
    expect([...allPaths].sort()).toEqual([...PATHS_BEFORE_THE_SURFACE_MERGE].sort());
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
    expect(findActiveHub(NAV_HUBS, '/companies')?.id).toBe('inbox');
    expect(findActiveHub(NAV_HUBS, '/documents')?.id).toBe('inbox');
    expect(findActiveHub(NAV_HUBS, '/calendar')?.id).toBe('inbox');
    expect(findActiveHub(NAV_HUBS, '/tasks')?.id).toBe('inbox');
    expect(findActiveHub(NAV_HUBS, '/voice/ivr')?.id).toBe('inbox');
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

  it('keeps Growth Studio a manager-only surface', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    expect(splitByTier(hubs).core.map((h) => h.id)).toContain('studio');
    // A rep still sees the surface (Reports lives there) but never the Studio page.
    const repHubs = visibleNav(NAV_HUBS, { isManager: false, has: entitle() });
    expect(childPaths(repHubs, 'studio')).not.toContain('/studio');
  });

  it('excludes the settings-area hub from both tiers', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    const { core, advanced } = splitByTier(hubs);
    expect([...core, ...advanced].some((h) => h.area === 'settings')).toBe(false);
  });
});
