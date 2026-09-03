import { ContentLineService } from './content-line.service';

/**
 * The batch summary is what the Growth Studio hub renders: one card per idea,
 * carrying what became of it. `ContentConcept.batchId` has existed since the
 * concept machinery shipped and appeared NOWHERE in the frontend — the database
 * knew "these five came from that idea" and no screen did. This service is the
 * read model that closes that gap.
 */

type Row = Record<string, unknown>;

function makePrisma(over: { concepts?: Row[]; items?: Row[]; targets?: Row[]; metrics?: Row[] } = {}) {
  return {
    contentConcept: { findMany: jest.fn().mockResolvedValue(over.concepts ?? []) },
    socialCampaignItem: { findMany: jest.fn().mockResolvedValue(over.items ?? []) },
    socialPostTarget: { findMany: jest.fn().mockResolvedValue(over.targets ?? []) },
    socialPostMetric: { groupBy: jest.fn().mockResolvedValue(over.metrics ?? []) },
  };
}

const WS = 'ws-1';
const OLD = new Date('2026-08-01T10:00:00Z');
const NEW = new Date('2026-09-01T10:00:00Z');

function concept(id: string, batchId: string, status: string, createdAt = NEW) {
  return { id, batchId, status, createdAt, sourceIdea: `idea of ${batchId}`, angle: 'curiosity' };
}

describe('ContentLineService.batches', () => {
  it('counts where each concept and its produced item currently stands', async () => {
    const prisma = makePrisma({
      concepts: [
        concept('c1', 'b1', 'PROPOSED'),
        concept('c2', 'b1', 'APPROVED'),
        concept('c3', 'b1', 'APPROVED'),
        concept('c4', 'b1', 'DISCARDED'),
      ],
      items: [
        { contentConceptId: 'c2', status: 'GENERATING', socialPostId: null },
        { contentConceptId: 'c3', status: 'PUBLISHED', socialPostId: 'p3' },
      ],
      targets: [{ id: 't3', postId: 'p3', status: 'PUBLISHED' }],
      metrics: [{ targetId: 't3', _sum: { impressions: 900, engagements: 90, reach: 800 } }],
    });
    const svc = new ContentLineService(prisma as any);

    const [batch] = await svc.batches(WS);

    expect(batch.batchId).toBe('b1');
    expect(batch.sourceIdea).toBe('idea of b1');
    expect(batch.concepts).toEqual({
      total: 4,
      awaitingReview: 1,
      approved: 2,
      discarded: 1,
    });
    expect(batch.production.generating).toBe(1);
    expect(batch.production.published).toBe(1);
  });

  it('reports reach as NULL for a batch that has published nothing, not zero', async () => {
    // Zero means "measured, and nobody saw it". Null means "not published yet".
    // A card that shows 0 reach on unpublished work reads as a failure that has
    // not happened.
    const prisma = makePrisma({
      concepts: [concept('c1', 'b1', 'APPROVED')],
      items: [{ contentConceptId: 'c1', status: 'GENERATING', socialPostId: null }],
    });
    const svc = new ContentLineService(prisma as any);

    const [batch] = await svc.batches(WS);

    expect(batch.reach).toBeNull();
    expect(batch.reach).not.toBe(0);
  });

  it('sums reach once a batch has published', async () => {
    const prisma = makePrisma({
      concepts: [concept('c1', 'b1', 'APPROVED')],
      items: [{ contentConceptId: 'c1', status: 'PUBLISHED', socialPostId: 'p1' }],
      targets: [
        { id: 't1', postId: 'p1', status: 'PUBLISHED' },
        { id: 't2', postId: 'p1', status: 'PUBLISHED' },
      ],
      metrics: [
        { targetId: 't1', _sum: { impressions: 500, engagements: 50, reach: 400 } },
        { targetId: 't2', _sum: { impressions: 300, engagements: 20, reach: 250 } },
      ],
    });
    const svc = new ContentLineService(prisma as any);

    const [batch] = await svc.batches(WS);

    // Reach sums across networks — that part is genuinely per-target...
    expect(batch.reach).toBe(650);
    // ...but the post itself is one piece of content, published twice.
    expect(batch.production.published).toBe(1);
  });

  it('puts the newest batch first', async () => {
    const prisma = makePrisma({
      concepts: [
        concept('c1', 'older', 'PROPOSED', OLD),
        concept('c2', 'newer', 'PROPOSED', NEW),
      ],
    });
    const svc = new ContentLineService(prisma as any);

    const batches = await svc.batches(WS);

    expect(batches.map((b) => b.batchId)).toEqual(['newer', 'older']);
  });

  it('returns an empty list rather than throwing when the workspace has no concepts', async () => {
    const svc = new ContentLineService(makePrisma() as any);
    await expect(svc.batches(WS)).resolves.toEqual([]);
  });

  it('scopes every query to the workspace', async () => {
    const prisma = makePrisma({
      concepts: [concept('c1', 'b1', 'APPROVED')],
      items: [{ contentConceptId: 'c1', status: 'PUBLISHED', socialPostId: 'p1' }],
      targets: [{ id: 't1', postId: 'p1', status: 'PUBLISHED' }],
      metrics: [{ targetId: 't1', _sum: { impressions: 1, engagements: 1, reach: 1 } }],
    });
    const svc = new ContentLineService(prisma as any);

    await svc.batches(WS);

    for (const call of [
      prisma.contentConcept.findMany,
      prisma.socialCampaignItem.findMany,
      prisma.socialPostTarget.findMany,
      prisma.socialPostMetric.groupBy,
    ]) {
      expect(call).toHaveBeenCalled();
      for (const args of call.mock.calls) {
        expect((args[0] as any).where).toMatchObject({ workspaceId: WS });
      }
    }
  });
});
