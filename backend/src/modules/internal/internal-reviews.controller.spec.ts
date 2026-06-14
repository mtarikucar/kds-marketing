import { InternalReviewsController } from './internal-reviews.controller';

describe('InternalReviewsController', () => {
  let prisma: any;
  let config: any;
  let ctrl: InternalReviewsController;

  const WS = {
    id: 'ws1',
    slug: 'a',
    productName: 'P',
    productDescription: 'D',
    defaultLanguage: 'tr',
  };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      review: { findMany: jest.fn(), updateMany: jest.fn() },
    };
    config = { get: jest.fn().mockReturnValue(undefined) }; // -> default cap
    ctrl = new InternalReviewsController(prisma as any, config as any);
  });

  describe('GET pending-drafts', () => {
    it('returns one job per active workspace with pending PRIVATE_FEEDBACK reviews', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([
        { id: 'rev1', rating: 2, text: 'bad', authorName: 'X' },
      ]);

      const res = await ctrl.pendingDrafts();

      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).workspaceId).toBe('ws1');
      expect((res.jobs[0] as any).reviews[0]).toEqual({
        reviewId: 'rev1',
        rating: 2,
        text: 'bad',
        authorName: 'X',
      });
      expect(prisma.review.findMany.mock.calls[0][0].where).toMatchObject({
        workspaceId: 'ws1',
        status: 'PRIVATE_FEEDBACK',
        replyText: null,
        replyDraft: null,
      });
    });

    it('omits workspaces with nothing pending', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([]);
      const res = await ctrl.pendingDrafts();
      expect(res.jobs).toHaveLength(0);
    });

    it('clips to the default per-workspace daily cap (50)', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([
        { id: 'rev1', rating: 1, text: 't', authorName: null },
      ]);
      await ctrl.pendingDrafts();
      expect(prisma.review.findMany.mock.calls[0][0].take).toBe(50);
    });

    it('honors the ROUTINE_REVIEW_DAILY_CAP override', async () => {
      config.get.mockReturnValue('10');
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([
        { id: 'rev1', rating: 1, text: 't', authorName: null },
      ]);
      await ctrl.pendingDrafts();
      expect(prisma.review.findMany.mock.calls[0][0].take).toBe(10);
    });
  });
});
