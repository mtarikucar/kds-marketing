import { describe, it, expect } from 'vitest';
import { NAV_GROUPS, visibleNav, type FeatureKey } from './navigation';

/** Entitle only the given feature keys; core (undefined) is always allowed. */
const entitle =
  (...keys: FeatureKey[]) =>
  (feature?: FeatureKey) =>
    feature ? keys.includes(feature) : true;

describe('visibleNav — role + entitlement gating', () => {
  it('a core-only REP sees just the pipeline (no advanced, no settings)', () => {
    const groups = visibleNav(NAV_GROUPS, { isManager: false, has: entitle() });
    const ids = groups.map((g) => g.id);
    expect(ids).toContain('pipeline');
    expect(ids).not.toContain('growth'); // every growth item is gated → group dropped
    expect(ids).not.toContain('settings'); // all managerOnly → dropped for a rep
  });

  it('drops a group once all its items are filtered out', () => {
    const groups = visibleNav(NAV_GROUPS, { isManager: true, has: entitle() });
    expect(groups.find((g) => g.id === 'growth')).toBeUndefined();
  });

  it('reveals exactly the entitled advanced modules, nothing more', () => {
    const groups = visibleNav(NAV_GROUPS, {
      isManager: true,
      has: entitle('conversationAi'),
    });
    const growth = groups.find((g) => g.id === 'growth');
    expect(growth).toBeDefined();
    const paths = growth!.items.map((i) => i.path).sort();
    // conversationAi gates Inbox + Channels; campaigns/sites/etc stay hidden.
    expect(paths).toEqual(['/channels', '/inbox']);
  });

  it('hides managerOnly items from a REP even when the feature is entitled', () => {
    const groups = visibleNav(NAV_GROUPS, {
      isManager: false,
      has: entitle('conversationAi'),
    });
    const growth = groups.find((g) => g.id === 'growth');
    // Inbox (not managerOnly) shows; Channels (managerOnly) does not.
    expect(growth!.items.map((i) => i.path)).toEqual(['/inbox']);
  });

  it('always shows core pipeline items regardless of entitlements', () => {
    const groups = visibleNav(NAV_GROUPS, { isManager: false, has: entitle() });
    const pipeline = groups.find((g) => g.id === 'pipeline');
    expect(pipeline!.items.map((i) => i.path)).toEqual([
      '/dashboard',
      '/leads',
      '/tasks',
      '/calendar',
      '/offers',
    ]);
  });

  it('hides the Agency group for a non-agency workspace (Epic D)', () => {
    const groups = visibleNav(NAV_GROUPS, { isManager: true, has: entitle() });
    expect(groups.find((g) => g.id === 'agency')).toBeUndefined();
  });

  it('shows the Agency group only for an AGENCY workspace manager', () => {
    const groups = visibleNav(NAV_GROUPS, {
      isManager: true,
      has: entitle(),
      isAgency: true,
    });
    const agency = groups.find((g) => g.id === 'agency');
    expect(agency).toBeDefined();
    expect(agency!.items.map((i) => i.path).sort()).toEqual([
      '/agency/locations',
      '/agency/rebilling',
      '/agency/snapshots',
    ]);
  });
});
