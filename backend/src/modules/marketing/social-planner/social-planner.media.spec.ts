import { BadRequestException } from '@nestjs/common';
import * as networkAdapters from './network-adapters';
import {
  SocialPlannerService,
  SOCIAL_MEDIA_CLEANUP_KIND,
} from './social-planner.service';

describe('SocialPlannerService — media + per-target format', () => {
  let prisma: any;
  let scheduledJobs: any;
  let runner: any;
  let r2: any;
  let svc: SocialPlannerService;

  beforeEach(() => {
    prisma = {
      socialPost: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      socialPostTarget: { update: jest.fn().mockResolvedValue({}) },
    };
    scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
    runner = { registerHandler: jest.fn() };
    r2 = { isConfigured: jest.fn().mockReturnValue(true), upload: jest.fn(), deleteKeys: jest.fn().mockResolvedValue(undefined) };
    svc = new SocialPlannerService(prisma, scheduledJobs, runner, r2);
  });

  it('uploadMedia rejects when R2 is not configured', async () => {
    r2.isConfigured.mockReturnValue(false);
    await expect(svc.uploadMedia('ws', { mimetype: 'image/png', buffer: Buffer.from(''), size: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('uploadMedia delegates to R2 when configured', async () => {
    r2.upload.mockResolvedValue({ url: 'https://r2/x.png', key: 'social/ws/x.png', mime: 'image/png' });
    const out = await svc.uploadMedia('ws', { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 });
    expect(out.key).toBe('social/ws/x.png');
    expect(r2.upload).toHaveBeenCalledWith('ws', expect.anything());
  });

  it('publishDuePost passes the per-target format + mime to the adapter', async () => {
    const spy = jest.spyOn(networkAdapters, 'publishToNetwork').mockResolvedValue({ ok: true, externalPostId: 'X1' });
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'SCHEDULED',
      content: 'hello',
      mediaUrls: ['https://r2/v.mp4'],
      options: { formats: { acc1: 'REEL' }, media: [{ url: 'https://r2/v.mp4', key: 'k1', mime: 'video/mp4' }] },
      targets: [{ id: 't1', status: 'PENDING', network: 'INSTAGRAM', socialAccountId: 'acc1', account: { id: 'acc1', network: 'INSTAGRAM' } }],
    });

    await svc.publishDuePost('p1', 'ws');

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acc1' }),
      'hello',
      ['https://r2/v.mp4'],
      { format: 'REEL', mediaMime: ['video/mp4'] },
    );
    // Cleanup scheduled 7 days out because the post had uploaded (keyed) media.
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_MEDIA_CLEANUP_KIND, dedupKey: 'social-media-cleanup-p1' }),
    );
    spy.mockRestore();
  });

  it('publishDuePost does NOT schedule cleanup when media has no R2 keys (pasted URLs)', async () => {
    const spy = jest.spyOn(networkAdapters, 'publishToNetwork').mockResolvedValue({ ok: true, externalPostId: 'X1' });
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 'p2',
      status: 'SCHEDULED',
      content: 'hi',
      mediaUrls: ['https://external/a.jpg'],
      options: { media: [{ url: 'https://external/a.jpg' }] },
      targets: [{ id: 't1', status: 'PENDING', network: 'FACEBOOK', socialAccountId: 'acc2', account: { id: 'acc2', network: 'FACEBOOK' } }],
    });

    await svc.publishDuePost('p2', 'ws');
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('cleanupPostMedia deletes R2 keys and marks mediaDeletedAt', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 'p1',
      options: { media: [{ url: 'u', key: 'k1' }, { url: 'u2', key: 'k2' }] },
    });
    await svc.cleanupPostMedia('p1', 'ws');
    expect(r2.deleteKeys).toHaveBeenCalledWith(['k1', 'k2']);
    const updateArg = prisma.socialPost.update.mock.calls[0][0];
    expect(updateArg.data.options.mediaDeletedAt).toBeDefined();
  });

  it('cleanupPostMedia is idempotent once mediaDeletedAt is set', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 'p1',
      options: { media: [{ url: 'u', key: 'k1' }], mediaDeletedAt: '2026-06-24T00:00:00.000Z' },
    });
    await svc.cleanupPostMedia('p1', 'ws');
    expect(r2.deleteKeys).not.toHaveBeenCalled();
    expect(prisma.socialPost.update).not.toHaveBeenCalled();
  });
});
