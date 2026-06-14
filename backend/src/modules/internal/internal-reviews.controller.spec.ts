import { NotFoundException } from '@nestjs/common';
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
    config = { get: jest.fn().mockReturnValue(undefined) }; // env var absent -> falls back to DEFAULT_DAILY_CAP
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

  describe('POST :workspaceId/drafts', () => {
    it('404s a non-ACTIVE (suspended) workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'SUSPENDED' });
      await expect(
        ctrl.submit('ws1', { drafts: [{ reviewId: 'r', replyDraft: 'hi' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(
        ctrl.submit('wsX', { drafts: [{ reviewId: 'r', replyDraft: 'hi' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('writes only still-empty drafts and counts written/skipped', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      prisma.review.updateMany
        .mockResolvedValueOnce({ count: 1 }) // rev1 written
        .mockResolvedValueOnce({ count: 0 }); // rev2 already filled -> skipped

      const res = await ctrl.submit('ws1', {
        drafts: [
          { reviewId: 'rev1', replyDraft: 'a' },
          { reviewId: 'rev2', replyDraft: 'b' },
        ],
      });

      expect(res).toEqual({ written: 1, skipped: 1 });
      // guarded WHERE prevents clobber + cross-workspace writes
      expect(prisma.review.updateMany.mock.calls[0][0].where).toMatchObject({
        id: 'rev1',
        workspaceId: 'ws1',
        replyDraft: null,
        replyText: null,
      });
    });
  });
});
