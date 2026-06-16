import { describe, it, expect } from 'vitest';
import { NAV_GROUPS, visibleNav, type FeatureKey } from './navigation';

/** Entitle only the given feature keys; core (undefined) is always allowed. */
const entitle =
  (...keys: FeatureKey[]) =>
  (feature?: FeatureKey) =>
    feature ? keys.includes(feature) : true;

describe('visibleNav — role + entitlement gating', () => {
  it('a core-only REP sees just the pipeline (no advanced)', () => {
    const groups = visibleNav(NAV_GROUPS, { isManager: false, has: entitle() });
    const ids = groups.map((g) => g.id);
    expect(ids).toContain('pipeline');
    expect(ids).not.toContain('growth'); // every growth item is gated → group dropped
    // Settings now carries one self-service (non-managerOnly) item — Two-factor
    // auth — so a core rep keeps the Settings group, but ONLY that item.
    const settings = groups.find((g) => g.id === 'settings');
    expect(settings).toBeDefined();
    expect(settings!.items.map((i) => i.path)).toEqual(['/settings/two-factor']);
  });

  it('drops a group once all its items are filtered out', () => {
    // A manager with NO entitlements still sees the core-but-managerOnly Growth
    // modules (Social Planner, Experiments, Surveys) which carry no feature key.
    const groups = visibleNav(NAV_GROUPS, { isManager: true, has: entitle() });
    const growth = groups.find((g) => g.id === 'growth');
    expect(growth).toBeDefined();
    expect(growth!.items.map((i) => i.path).sort()).toEqual([
      '/experiments',
      '/social',
      '/surveys',
    ]);
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
    // The core-but-managerOnly Growth modules (no feature key) are always shown
    // to a manager regardless of entitlement.
    expect(paths).toEqual([
      '/channels',
      '/experiments',
      '/inbox',
      '/social',
      '/surveys',
    ]);
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
