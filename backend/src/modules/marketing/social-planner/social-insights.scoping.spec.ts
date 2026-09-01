import { SocialInsightsService } from './social-insights.service';

jest.mock('./network-adapters', () => ({ isNetworkConfigured: jest.fn(() => true) }));
jest.mock('./network-insights', () => ({
  fetchPostInsights: jest.fn().mockResolvedValue({ ok: true, data: { impressions: 1 } }),
  fetchAccountInsights: jest.fn().mockResolvedValue({ ok: true, data: { followers: 1 } }),
  networkSupportsInsights: jest.fn(() => true),
}));

/**
 * Multi-tenant isolation for the insights read/write paths.
 *
 * The architecture-fitness test (workspace-scoping.arch.spec.ts) proves
 * STATICALLY that the string "workspaceId" appears inside every multi-row query
 * on a workspace-owned delegate. That is a regex over source text, and it
 * cannot tell a real filter from a `select: { workspaceId: true }` — so this
 * spec asserts the thing that actually matters at runtime: every query the
 * service issues carries the CALLER'S workspace id in its `where`, and there is
 * no relation hop that reaches sideways into another tenant's rows.
 *
 * It matters most for summary(). A report is a read of a lot of rows at once,
 * SocialPostMetric and SocialAccountMetric both carry workspaceId, and a filter
 * expressed only through a relation (`target: { post: {...} }`) with the
 * workspace forgotten at the top level would return every tenant's numbers
 * while looking perfectly reasonable in review.
 */

const WS = 'ws-tenant-A';

function recordingPrisma() {
  const seen: Array<{ call: string; args: any }> = [];
  const delegate = (name: string, results: Record<string, any>) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          jest.fn((args: any) => {
            seen.push({ call: `${name}.${String(method)}`, args });
            return Promise.resolve(results[String(method)] ?? []);
          }),
      },
    );
  const prisma = {
    socialAccount: delegate('socialAccount', {
      findMany: [
        { id: 'a1', workspaceId: WS, network: 'INSTAGRAM', externalId: 'IG', accessToken: 's', accountType: null, displayName: 'IG', enabled: true, insightsPulledAt: null },
      ],
      updateMany: { count: 1 },
    }),
    socialPostTarget: delegate('socialPostTarget', {
      findMany: [
        { id: 't1', socialAccountId: 'a1', externalPostId: 'P1', network: 'INSTAGRAM', post: { publishedAt: new Date('2026-06-02T00:00:00.000Z') } },
      ],
      count: 1,
    }),
    socialPostMetric: delegate('socialPostMetric', { findMany: [] }),
    socialAccountMetric: delegate('socialAccountMetric', { findMany: [], upsert: {} }),
  } as any;
  return { prisma, seen };
}

/** Every recorded call must filter (or write) on the caller's workspace. */
function assertScoped(seen: Array<{ call: string; args: any }>) {
  for (const { call, args } of seen) {
    const where = args?.where ?? {};
    const scope = where.workspaceId ?? args?.create?.workspaceId;
    expect({ call, scope }).toEqual({ call, scope: WS });
  }
}

describe('SocialInsightsService — workspace scoping', () => {
  it('summary() filters every read by the caller workspace, including the metric tables', async () => {
    const { prisma, seen } = recordingPrisma();
    await new SocialInsightsService(prisma, { upsert: jest.fn() } as any).summary(
      WS,
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-30T00:00:00.000Z'),
    );

    const calls = seen.map((s) => s.call);
    expect(calls).toEqual(
      expect.arrayContaining([
        'socialAccount.findMany',
        'socialPostTarget.findMany',
        'socialPostMetric.findMany',
        'socialAccountMetric.findMany',
      ]),
    );
    assertScoped(seen);

    // The post-metric read narrows through a relation as well as at the top
    // level. The relation filter is an optimisation (it replaces a 20k-element
    // `targetId: { in: [...] }`); the top-level workspaceId is the isolation,
    // and BOTH must be present — a relation-only filter would be a silent
    // cross-tenant read the moment the relation shape changed.
    const postMetric = seen.find((s) => s.call === 'socialPostMetric.findMany');
    expect(postMetric.args.where.workspaceId).toBe(WS);
    expect(postMetric.args.where.target.workspaceId).toBe(WS);
  });

  it('pullWorkspace() scopes every read and every write to the caller workspace', async () => {
    const { prisma, seen } = recordingPrisma();
    await new SocialInsightsService(prisma, { upsert: jest.fn() } as any).pullWorkspace(WS, { force: true });

    const calls = seen.map((s) => s.call);
    expect(calls).toEqual(
      expect.arrayContaining([
        'socialAccount.findMany',
        'socialPostTarget.findMany',
        'socialAccountMetric.upsert',
        'socialAccount.updateMany',
      ]),
    );

    // The bookkeeping write is keyed by (id, workspaceId) rather than by id
    // alone: an id-only update would be a cross-tenant write if an id ever
    // leaked, and updateMany with a wrong workspace simply matches nothing.
    const stamp = seen.find((s) => s.call === 'socialAccount.updateMany');
    expect(stamp.args.where).toEqual({ id: 'a1', workspaceId: WS });

    // The upsert is keyed on the unique (socialAccountId, date), so its scope
    // lives in `create.workspaceId` — asserted here because a create is the one
    // place a row can be BORN in the wrong tenant.
    const upsert = seen.find((s) => s.call === 'socialAccountMetric.upsert');
    expect(upsert.args.create.workspaceId).toBe(WS);

    assertScoped(seen.filter((s) => s.call !== 'socialAccountMetric.upsert'));
  });

  it('never derives a scope from a possibly-undefined id (Prisma would drop it and match every row)', async () => {
    const { prisma, seen } = recordingPrisma();
    await new SocialInsightsService(prisma, { upsert: jest.fn() } as any).summary(
      WS,
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-30T00:00:00.000Z'),
    );
    for (const { call, args } of seen) {
      const where = args?.where ?? {};
      for (const [key, value] of Object.entries(where)) {
        expect({ call, key, undef: value === undefined }).toEqual({ call, key, undef: false });
      }
    }
  });
});
