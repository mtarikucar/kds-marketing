import { NotFoundException } from '@nestjs/common';
import { InternalContentController } from './internal-content.controller';

describe('InternalContentController', () => {
  let prisma: any;
  let ctrl: InternalContentController;

  const WS = { id: 'ws1', slug: 'a', productName: 'P', productDescription: 'D', defaultLanguage: 'tr' };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      contentProfile: { findMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      contentDraft: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    ctrl = new InternalContentController(prisma as any);
  });

  describe('GET jobs', () => {
    it('emits one job per ACTIVE due profile, with clamped counts', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.contentProfile.findMany.mockResolvedValue([
        { id: 'cp1', name: 'n', themes: 't', voice: 'v', language: 'tr', counts: { social: 99, email: 2, sms: 1 } },
      ]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).profile.counts).toEqual({ social: 10, email: 2, sms: 1 }); // social clamped 99->10
      // due filter present (OR lastRunAt null / < cutoff)
      const where = prisma.contentProfile.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: 'ws1', status: 'ACTIVE' });
      expect(where.OR[0]).toEqual({ lastRunAt: null });
      expect(where.OR[1].lastRunAt.lt).toBeInstanceOf(Date);
    });

    it('skips a profile whose clamped counts are all zero', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.contentProfile.findMany.mockResolvedValue([
        { id: 'cp1', name: 'n', themes: 't', voice: null, language: 'tr', counts: { social: 0, email: 0, sms: 0 } },
      ]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });

    it('omits workspaces with no due profile', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.contentProfile.findMany.mockResolvedValue([]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });
  });

  describe('POST jobs/:workspaceId/drafts', () => {
    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(
        ctrl.submit('wsX', { profileId: 'cp1', drafts: [{ channel: 'social', body: 'x' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('createMany the drafts and stamps the profile lastRunAt', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      prisma.contentDraft.createMany.mockResolvedValue({ count: 2 });
      const res = await ctrl.submit('ws1', {
        profileId: 'cp1',
        drafts: [
          { channel: 'social', body: 'a' },
          { channel: 'email', subject: 's', body: 'b' },
        ],
      });
      expect(res).toEqual({ created: 2 });
      const rows = prisma.contentDraft.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ workspaceId: 'ws1', contentProfileId: 'cp1', channel: 'social', body: 'a' });
      // profile stamp scoped by {id, workspaceId}
      expect(prisma.contentProfile.updateMany.mock.calls[0][0].where).toEqual({ id: 'cp1', workspaceId: 'ws1' });
    });
  });
});
