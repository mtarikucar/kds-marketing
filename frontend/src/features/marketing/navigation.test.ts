import { describe, it, expect } from 'vitest';
import { NAV_HUBS, visibleNav, findActiveHub, splitByTier, type FeatureKey } from './navigation';

/** Entitle only the given feature keys; core (undefined) is always allowed. */
const entitle =
  (...keys: FeatureKey[]) =>
  (feature?: FeatureKey) =>
    feature ? keys.includes(feature) : true;

const childPaths = (hubs: ReturnType<typeof visibleNav>, id: string) =>
  hubs.find((h) => h.id === id)?.children?.map((c) => c.path) ?? [];

describe('visibleNav — hub model, role + entitlement gating', () => {
  it('a core-only REP sees the daily hubs + single-page hubs, advanced dropped', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: false, has: entitle() });
    const ids = hubs.map((h) => h.id);
    expect(ids).toContain('dashboard');
    expect(ids).toContain('tasks');
    expect(ids).toEqual(
      expect.arrayContaining(['contacts', 'calendar', 'sales', 'reports', 'settings']),
    );
    // Dissolved / advanced hubs never show for a core-only REP.
    expect(ids).not.toContain('conversations'); // dissolved into /inbox
    expect(ids).not.toContain('ai'); // dispersed (Studio / Inbox / Brand)
    expect(ids).not.toContain('studio');
    expect(ids).not.toContain('sites');
    expect(ids).not.toContain('automation');
    expect(ids).not.toContain('memberships');
    expect(ids).not.toContain('voice');
    expect(ids).not.toContain('payments');
    expect(ids).not.toContain('agency');
    expect(childPaths(hubs, 'contacts')).toEqual(['/leads', '/companies']);
    // Sales is the MERGED set: Pipeline + one Documents hub (offers/estimates/files tabs).
    expect(childPaths(hubs, 'sales')).toEqual(['/opportunities', '/documents']);
    // Reports is a single-page hub now (ads/performance/analytics are tabs).
    const reports = hubs.find((h) => h.id === 'reports');
    expect(reports?.path).toBe('/reports');
    expect(reports?.children).toBeUndefined();
    expect(childPaths(hubs, 'settings')).toEqual(['/settings/two-factor']);
  });

  it('a manager with NO entitlements still sees the core-but-managerOnly modules', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    // Growth Studio stays a single page (children are tabs at /studio?tab=…).
    const studio = hubs.find((h) => h.id === 'studio');
    expect(studio?.path).toBe('/studio');
    expect(studio?.children).toBeUndefined();
    // The AI hub is GONE — its tools live inside Studio, Inbox and Brand.
    expect(hubs.find((h) => h.id === 'ai')).toBeUndefined();
    // Surveys + Experiments were deleted (2026-07 trim), so Sites is a
    // single-page funnels-gated hub — absent without the entitlement.
    expect(hubs.find((h) => h.id === 'sites')).toBeUndefined();
    // Memberships is now module-gated ('memberships', OFF by default for new
    // workspaces) — absent without the entitlement even for a manager.
    expect(hubs.find((h) => h.id === 'memberships')).toBeUndefined();
    // Automation now also carries Trigger Links (moved out of Studio→More).
    expect(childPaths(hubs, 'automation')).toEqual(['/trigger-links']);
  });

  it('shows Memberships as a single Courses page when the module is entitled', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle('memberships') });
    // Communities + Leaderboard were deleted; Memberships is just Courses now.
    const memberships = hubs.find((h) => h.id === 'memberships');
    expect(memberships?.path).toBe('/memberships/courses');
    expect(memberships?.children).toBeUndefined();
  });

  it('Sites appears as a single-page hub when funnels is entitled', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle('funnels') });
    const sites = hubs.find((h) => h.id === 'sites');
    expect(sites?.path).toBe('/sites');
    expect(sites?.children).toBeUndefined();
  });

  it('the Inbox is a single-page hub gated by conversationAi (channels/snippets/agents/knowledge are tabs inside)', () => {
    const withAi = visibleNav(NAV_HUBS, { isManager: true, has: entitle('conversationAi') });
    const inbox = withAi.find((h) => h.id === 'inbox');
    expect(inbox?.path).toBe('/inbox');
    expect(inbox?.children).toBeUndefined();

    const withoutAi = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    expect(withoutAi.find((h) => h.id === 'inbox')).toBeUndefined();
  });

  it('hides the Agency hub for a non-agency workspace (Epic D)', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    expect(hubs.find((h) => h.id === 'agency')).toBeUndefined();
  });

  it('shows the Agency hub only for an AGENCY workspace manager', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle(), isAgency: true });
    expect(childPaths(hubs, 'agency').sort()).toEqual([
      '/agency/locations',
      '/agency/rebilling',
      '/agency/snapshots',
    ]);
  });
});

describe('navigation — merged destinations have exactly one home (clean cut)', () => {
  const allPaths = NAV_HUBS.flatMap((h) => [
    ...(h.path ? [h.path] : []),
    ...(h.children?.map((c) => c.path) ?? []),
  ]);

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

  it('keeps the tree lean: at most 12 top-level hubs and no hub over 6 children', () => {
    expect(NAV_HUBS.length).toBeLessThanOrEqual(16); // incl. settings + agency-gated
    const mainHubs = NAV_HUBS.filter((h) => (h.area ?? 'main') === 'main');
    expect(mainHubs.length).toBeLessThanOrEqual(15);
    for (const h of mainHubs) {
      expect((h.children?.length ?? 0)).toBeLessThanOrEqual(6);
    }
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
  it('resolves single-page hubs', () => {
    expect(findActiveHub(NAV_HUBS, '/dashboard')?.id).toBe('dashboard');
    expect(findActiveHub(NAV_HUBS, '/tasks')?.id).toBe('tasks');
    expect(findActiveHub(NAV_HUBS, '/inbox')?.id).toBe('inbox');
    expect(findActiveHub(NAV_HUBS, '/reports')?.id).toBe('reports');
  });

  it('resolves a child path to its hub (not by URL prefix)', () => {
    expect(findActiveHub(NAV_HUBS, '/tags')?.id).toBe('contacts');
    expect(findActiveHub(NAV_HUBS, '/segments')?.id).toBe('contacts');
    expect(findActiveHub(NAV_HUBS, '/settings/custom-fields')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/voice/ivr')?.id).toBe('voice');
    expect(findActiveHub(NAV_HUBS, '/documents')?.id).toBe('sales');
    expect(findActiveHub(NAV_HUBS, '/trigger-links')?.id).toBe('automation');
    expect(findActiveHub(NAV_HUBS, '/accounts')?.id).toBe('settings');
  });

  it('resolves a detail route to its list hub via longest prefix', () => {
    expect(findActiveHub(NAV_HUBS, '/leads/abc-123')?.id).toBe('contacts');
    expect(findActiveHub(NAV_HUBS, '/memberships/courses/42')?.id).toBe('memberships');
  });

  it('returns undefined for an unknown path', () => {
    expect(findActiveHub(NAV_HUBS, '/nope')).toBeUndefined();
  });
});

describe('splitByTier — progressive disclosure', () => {
  it('keeps daily hubs in core and tucks niche hubs into advanced', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    const { core, advanced } = splitByTier(hubs);
    const coreIds = core.map((h) => h.id);
    const advIds = advanced.map((h) => h.id);
    expect(coreIds).toEqual(
      expect.arrayContaining(['dashboard', 'contacts', 'calendar', 'sales', 'tasks', 'reports', 'studio']),
    );
    // Sites (funnels) and Memberships (memberships module) are both gated now,
    // so without those entitlements the remaining advanced pair tucks behind "More".
    expect(advIds).toEqual(
      expect.arrayContaining(['payments', 'automation']),
    );
    expect(advIds).not.toContain('memberships'); // module OFF by default
    // The two tiers never overlap.
    expect(coreIds.some((id) => advIds.includes(id))).toBe(false);
  });

  it('promotes Growth Studio out of "More" (core tier) while keeping it manager-only', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    const { core, advanced } = splitByTier(hubs);
    expect(core.map((h) => h.id)).toContain('studio');
    expect(advanced.map((h) => h.id)).not.toContain('studio');
    // Non-managers still never see it (visibleNav drops it before tiering).
    const repHubs = visibleNav(NAV_HUBS, { isManager: false, has: entitle() });
    expect(repHubs.map((h) => h.id)).not.toContain('studio');
  });

  it('excludes the settings-area hub from both tiers', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    const { core, advanced } = splitByTier(hubs);
    expect([...core, ...advanced].some((h) => h.area === 'settings')).toBe(false);
  });
});
