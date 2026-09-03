import { AnglePerformanceService, MIN_POSTS_FOR_RANKING } from './angle-performance.service';

/**
 * The chain under test is five levels deep and every level is a SOFT reference:
 *
 *   ContentConcept (angle)
 *     ← SocialCampaignItem.contentConceptId   (no Prisma relation)
 *     → SocialCampaignItem.socialPostId       (no Prisma relation)
 *       → SocialPostTarget.postId
 *         → SocialPostMetric.targetId
 *
 * so the service walks it with four queries rather than one include. These unit
 * tests pin the ARITHMETIC and the REFUSALS; `content-line.realdb.e2e-spec.ts`
 * pins that the queries are actually valid against Postgres — a mock accepts
 * every `where` and this repo has already shipped `workspaceId: { in: [id, null] }`
 * past eight weeks of a green suite.
 */

type Row = Record<string, unknown>;

function makePrisma(over: {
  concepts?: Row[];
  items?: Row[];
  targets?: Row[];
  metrics?: Row[];
} = {}) {
  return {
    contentConcept: { findMany: jest.fn().mockResolvedValue(over.concepts ?? []) },
    socialCampaignItem: { findMany: jest.fn().mockResolvedValue(over.items ?? []) },
    socialPostTarget: { findMany: jest.fn().mockResolvedValue(over.targets ?? []) },
    socialPostMetric: { groupBy: jest.fn().mockResolvedValue(over.metrics ?? []) },
  };
}

const WS = 'ws-1';

/** Concept `c<n>` on `angle`, promoted to an item that became post `p<n>`, with
 *  one PUBLISHED target `t<n>` carrying the given totals. */
function chain(n: number, angle: string, impressions: number, engagements: number) {
  return {
    concept: { id: `c${n}`, angle },
    item: { contentConceptId: `c${n}`, socialPostId: `p${n}` },
    target: { id: `t${n}`, postId: `p${n}`, status: 'PUBLISHED' },
    metric: { targetId: `t${n}`, _sum: { impressions, engagements } },
  };
}

function seed(...chains: ReturnType<typeof chain>[]) {
  return makePrisma({
    concepts: chains.map((c) => c.concept),
    items: chains.map((c) => c.item),
    targets: chains.map((c) => c.target),
    metrics: chains.map((c) => c.metric),
  });
}

describe('AnglePerformanceService', () => {
  it('ranks by engagement RATE, not by raw reach', async () => {
    // `story` is seen five times more than `engineering` and converts far worse.
    // Ranking on raw reach would put it first; ranking on rate must not.
    const prisma = seed(
      ...Array.from({ length: MIN_POSTS_FOR_RANKING }, (_, i) =>
        chain(i + 1, 'story', 100_000, 1_000),           // rate 0.01
      ),
      ...Array.from({ length: MIN_POSTS_FOR_RANKING }, (_, i) =>
        chain(i + 100, 'engineering', 20_000, 2_000),    // rate 0.10
      ),
    );
    const svc = new AnglePerformanceService(prisma as any);

    const res = await svc.byAngle(WS);

    expect(res.cold).toBe(false);
    expect(res.angles.map((a) => a.angle)).toEqual(['engineering', 'story']);
    expect(res.angles[0].rate).toBeCloseTo(0.1);
    expect(res.angles[1].rate).toBeCloseTo(0.01);
    // The loser still out-reached the winner — the point of the assertion.
    expect(res.angles[1].impressions).toBeGreaterThan(res.angles[0].impressions);
  });

  it('refuses to rank an angle carrying fewer than the minimum posts', async () => {
    const prisma = seed(
      ...Array.from({ length: MIN_POSTS_FOR_RANKING }, (_, i) =>
        chain(i + 1, 'engineering', 10_000, 500),
      ),
      chain(99, 'lucky', 10, 9), // one post, rate 0.9 — the flukiest possible win
    );
    const svc = new AnglePerformanceService(prisma as any);

    const res = await svc.byAngle(WS);

    const lucky = res.angles.find((a) => a.angle === 'lucky')!;
    expect(lucky.insufficient).toBe(true);
    // Visible (the panel says "not enough data") but never ranked above a
    // measured angle, and never given weight.
    expect(res.angles[0].angle).toBe('engineering');
    expect(res.weights['lucky']).toBeUndefined();
    expect(res.weights['engineering']).toBeGreaterThan(0);
  });

  it('reports COLD rather than empty when nothing has ever been published', async () => {
    // A workspace can hold concepts and still have published nothing — which is
    // exactly today's live state (zero connected accounts). "No data yet" and
    // "measured and found nothing" must not look the same.
    const prisma = makePrisma({ concepts: [{ id: 'c1', angle: 'curiosity' }] });
    const svc = new AnglePerformanceService(prisma as any);

    const res = await svc.byAngle(WS);

    expect(res.cold).toBe(true);
    expect(res.angles).toEqual([]);
    expect(res.weights).toEqual({});
  });

  it('survives a target with zero impressions instead of dividing by it', async () => {
    const prisma = seed(
      ...Array.from({ length: MIN_POSTS_FOR_RANKING }, (_, i) =>
        chain(i + 1, 'sensory', 0, 0),
      ),
    );
    const svc = new AnglePerformanceService(prisma as any);

    const res = await svc.byAngle(WS);

    const sensory = res.angles.find((a) => a.angle === 'sensory')!;
    expect(sensory.rate).toBeNull();          // not NaN, not 0 — unmeasurable
    expect(Number.isNaN(sensory.rate as any)).toBe(false);
    expect(res.weights['sensory']).toBeUndefined();
  });

  it('scopes every query to the workspace', async () => {
    const prisma = seed(chain(1, 'curiosity', 100, 10));
    const svc = new AnglePerformanceService(prisma as any);

    await svc.byAngle(WS);

    for (const call of [
      prisma.contentConcept.findMany,
      prisma.socialCampaignItem.findMany,
      prisma.socialPostTarget.findMany,
      prisma.socialPostMetric.groupBy,
    ]) {
      expect(call).toHaveBeenCalled();
      expect((call.mock.calls[0][0] as any).where).toMatchObject({ workspaceId: WS });
    }
  });
});
