import { describe, it, expect } from 'vitest';
import { NAV_HUBS, visibleNav, findActiveHub, type FeatureKey } from './navigation';

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
      expect.arrayContaining(['contacts', 'calendar', 'sales', 'reporting', 'settings']),
    );
    expect(ids).not.toContain('conversations');
    expect(ids).not.toContain('marketing');
    expect(ids).not.toContain('sites');
    expect(ids).not.toContain('automation');
    expect(ids).not.toContain('memberships');
    expect(ids).not.toContain('voice');
    expect(ids).not.toContain('payments');
    expect(ids).not.toContain('agency');
    expect(childPaths(hubs, 'contacts')).toEqual(['/leads']);
    expect(childPaths(hubs, 'sales')).toEqual(['/opportunities', '/estimates', '/documents', '/offers']);
    expect(childPaths(hubs, 'reporting')).toEqual(['/reports', '/performance']);
    expect(childPaths(hubs, 'settings')).toEqual(['/settings/two-factor']);
  });

  it('a manager with NO entitlements still sees the core-but-managerOnly modules', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle() });
    expect(childPaths(hubs, 'marketing')).toEqual(['/social']);
    expect(childPaths(hubs, 'sites').sort()).toEqual(['/experiments', '/surveys']);
    expect(childPaths(hubs, 'memberships').sort()).toEqual([
      '/memberships/communities',
      '/memberships/courses',
    ]);
  });

  it('reveals exactly the entitled modules, nothing more', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: true, has: entitle('conversationAi') });
    expect(childPaths(hubs, 'conversations').sort()).toEqual(['/channels', '/inbox']);
    expect(hubs.find((h) => h.id === 'voice')).toBeUndefined();
  });

  it('hides managerOnly children from a REP even when the feature is entitled', () => {
    const hubs = visibleNav(NAV_HUBS, { isManager: false, has: entitle('conversationAi') });
    expect(childPaths(hubs, 'conversations')).toEqual(['/inbox']);
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

describe('findActiveHub — path → owning hub', () => {
  it('resolves single-page hubs', () => {
    expect(findActiveHub(NAV_HUBS, '/dashboard')?.id).toBe('dashboard');
    expect(findActiveHub(NAV_HUBS, '/tasks')?.id).toBe('tasks');
  });

  it('resolves a child path to its hub (not by URL prefix)', () => {
    expect(findActiveHub(NAV_HUBS, '/settings/tags')?.id).toBe('contacts');
    expect(findActiveHub(NAV_HUBS, '/settings/segments')?.id).toBe('contacts');
    expect(findActiveHub(NAV_HUBS, '/settings/custom-fields')?.id).toBe('settings');
    expect(findActiveHub(NAV_HUBS, '/voice/ivr')?.id).toBe('voice');
  });

  it('resolves a detail route to its list hub via longest prefix', () => {
    expect(findActiveHub(NAV_HUBS, '/leads/abc-123')?.id).toBe('contacts');
    expect(findActiveHub(NAV_HUBS, '/memberships/courses/42')?.id).toBe('memberships');
  });

  it('returns undefined for an unknown path', () => {
    expect(findActiveHub(NAV_HUBS, '/nope')).toBeUndefined();
  });
});
