import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialPlannerService } from './social-planner.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * A scheduled post used to be uncorrectable. `updatePost` refuses anything but
 * a DRAFT — rightly, since the publish job must not have the copy change under
 * it — so the only escape was `deletePost`: destructive, approval-gated, and it
 * throws away the copy, media and target accounts to fix a typo in a URL.
 *
 * `unschedulePost` is the reversible way out, and it moves in the safe
 * direction: the post leaves the publish queue rather than entering it.
 */
describe('SocialPlannerService.unschedulePost', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let scheduledJobs: { schedule: jest.Mock; cancel: jest.Mock };
  let svc: SocialPlannerService;

  const build = () =>
    new SocialPlannerService(
      prisma as any,
      scheduledJobs as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  beforeEach(() => {
    prisma = mockPrismaClient();
    scheduledJobs = { schedule: jest.fn(), cancel: jest.fn().mockResolvedValue(true) };
    svc = build();
    prisma.socialPost.update.mockResolvedValue({} as any);
    prisma.socialPost.findUnique?.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as any);
  });

  const scheduled = { id: 'p1', status: 'SCHEDULED' };

  it('returns the post to DRAFT and clears its send time', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(scheduled as any);
    jest.spyOn(svc, 'getPost').mockResolvedValue({ id: 'p1', status: 'DRAFT' } as never);

    await svc.unschedulePost(WS, 'p1');

    expect(prisma.socialPost.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: 'DRAFT', scheduledAt: null },
    });
  });

  it('cancels the queued job with the key schedulePost created it under', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(scheduled as any);
    jest.spyOn(svc, 'getPost').mockResolvedValue({} as never);

    await svc.unschedulePost(WS, 'p1');

    // A leftover job is the whole risk: the post would go out at the old time
    // with the old copy. The dedupKey must match schedulePost's exactly.
    expect(scheduledJobs.cancel).toHaveBeenCalledWith(expect.any(String), 'social-post-p1');
  });

  it('cancels the job BEFORE flipping the status', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(scheduled as any);
    jest.spyOn(svc, 'getPost').mockResolvedValue({} as never);
    const order: string[] = [];
    scheduledJobs.cancel.mockImplementation(async () => {
      order.push('cancel');
      return true;
    });
    prisma.socialPost.update.mockImplementation(async () => {
      order.push('update');
      return {} as any;
    });

    await svc.unschedulePost(WS, 'p1');

    // The other order can strand a post as SCHEDULED with no job — it would
    // then never publish and never say so. This order's only partial state is
    // a DRAFT with a live job, which publishDuePost now refuses.
    expect(order).toEqual(['cancel', 'update']);
  });

  it('is a no-op on a post that is already a draft', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as any);
    jest.spyOn(svc, 'getPost').mockResolvedValue({ id: 'p1' } as never);

    await svc.unschedulePost(WS, 'p1');

    expect(scheduledJobs.cancel).not.toHaveBeenCalled();
    expect(prisma.socialPost.update).not.toHaveBeenCalled();
  });

  it('refuses a post that already went out — there is no unpublishing', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'p1', status: 'PUBLISHED' } as any);
    await expect(svc.unschedulePost(WS, 'p1')).rejects.toThrow(BadRequestException);
    expect(scheduledJobs.cancel).not.toHaveBeenCalled();
  });

  it('scopes to the caller workspace', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(null);
    await expect(svc.unschedulePost(WS, 'p1')).rejects.toThrow(NotFoundException);
    expect(prisma.socialPost.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1', workspaceId: WS } }),
    );
  });
});

/**
 * The queue published whatever its job pointed at, checking only for an
 * already-PUBLISHED row. So a post moved back to DRAFT — by unschedulePost or
 * anything else — would still have gone live if its job outlived the cancel.
 */
describe('SocialPlannerService.publishDuePost — draft guard', () => {
  const WS = 'ws-1';

  it('refuses to publish a DRAFT', async () => {
    const prisma = mockPrismaClient();
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'DRAFT',
      targets: [],
      mediaUrls: [],
      options: {},
    } as any);

    const svc = new SocialPlannerService(
      prisma as any,
      { schedule: jest.fn(), cancel: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await svc.publishDuePost('p1', WS);

    // Never even claims the row — the tell that it stopped at the guard.
    expect(prisma.socialPost.update).not.toHaveBeenCalled();
  });
});
