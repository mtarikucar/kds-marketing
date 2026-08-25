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

/**
 * "Publish now" on a DRAFT was a silent no-op.
 *
 * publishNow accepted DRAFT or SCHEDULED and handed straight to publishDuePost,
 * which refuses a DRAFT — the guard added above, and rightly so: it is what
 * stops a stale queue job from publishing a post someone pulled back. So the
 * endpoint returned 200, the SPA showed "Publishing started", the post stayed
 * DRAFT, no target was touched and no adapter was called. The same hole ran
 * through MCP, where `jeeta.publish_social_post` is approval-gated: a human
 * approved a publish that could not happen.
 */
describe('SocialPlannerService.publishNow — DRAFT', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: SocialPlannerService;

  const build = () =>
    new SocialPlannerService(
      prisma as any,
      { schedule: jest.fn(), cancel: jest.fn().mockResolvedValue(true) } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );

  beforeEach(() => {
    prisma = mockPrismaClient();
    prisma.socialPost.updateMany?.mockResolvedValue({ count: 1 } as any);
    prisma.socialPost.update.mockResolvedValue({} as any);
    svc = build();
    jest.spyOn(svc, 'getPost').mockResolvedValue({} as never);
  });

  it('clears the draft before delegating, so the post actually goes out', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as any);
    const publish = jest.spyOn(svc, 'publishDuePost').mockResolvedValue(undefined as never);

    await svc.publishNow(WS, 'p1');

    expect(prisma.socialPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1', workspaceId: WS, status: 'DRAFT' },
        data: expect.objectContaining({ status: 'SCHEDULED' }),
      }),
    );
    expect(publish).toHaveBeenCalledWith('p1', WS);
  });

  it('scopes the clear to the caller workspace and to DRAFT only', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as any);
    jest.spyOn(svc, 'publishDuePost').mockResolvedValue(undefined as never);

    await svc.publishNow(WS, 'p1');

    // Two concurrent clicks must not both believe they cleared it.
    const where = (prisma.socialPost.updateMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe('DRAFT');
    expect(where.workspaceId).toBe(WS);
  });

  it('refuses when the row is no longer a DRAFT by the time it is claimed', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as any);
    prisma.socialPost.updateMany?.mockResolvedValue({ count: 0 } as any);
    const publish = jest.spyOn(svc, 'publishDuePost').mockResolvedValue(undefined as never);

    await expect(svc.publishNow(WS, 'p1')).rejects.toThrow(BadRequestException);
    expect(publish).not.toHaveBeenCalled();
  });

  it('leaves a SCHEDULED post alone — it is already cleared', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'p1', status: 'SCHEDULED' } as any);
    const publish = jest.spyOn(svc, 'publishDuePost').mockResolvedValue(undefined as never);

    await svc.publishNow(WS, 'p1');

    expect(prisma.socialPost.updateMany).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('p1', WS);
  });

  it('still refuses a post that already went out', async () => {
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'p1', status: 'PUBLISHED' } as any);
    await expect(svc.publishNow(WS, 'p1')).rejects.toThrow(BadRequestException);
  });
});

/**
 * Reconnecting an account has to actually repair it.
 *
 * `needsReconnect` folds `enabled !== true || expired || Boolean(lastError)`
 * (social.tools.ts:67). connectAccount's update branch re-enabled the row and
 * rotated the token but never cleared lastError, so an account you had just
 * reconnected kept reporting "reconnect needed" — and disconnectAccount writes
 * lastError='disconnected', so every disconnect/reconnect round trip landed in
 * exactly that state.
 *
 * It also did `tokenExpiresAt: dto.tokenExpiresAt ?? null`, wiping the expiry on
 * any rotation that carried no date. The refresh cron's due query requires
 * `tokenExpiresAt: { not: null }`, so the account silently left the refresh
 * queue for good and died when its token ran out.
 */
describe('SocialPlannerService.connectAccount — repair semantics', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: SocialPlannerService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    prisma.socialAccount.upsert?.mockResolvedValue({ id: 'a1', network: 'LINKEDIN' } as any);
    svc = new SocialPlannerService(
      prisma as any,
      { schedule: jest.fn(), cancel: jest.fn() } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
  });

  const base = {
    network: 'LINKEDIN',
    externalId: 'urn:li:org:1',
    displayName: 'Acme',
    accessToken: 'tok',
  };

  it('clears lastError, so a repaired account stops reporting needsReconnect', async () => {
    await svc.connectAccount(WS, base);

    const call = (prisma.socialAccount.upsert as jest.Mock).mock.calls[0][0];
    expect(call.update.lastError).toBeNull();
    expect(call.update.enabled).toBe(true);
  });

  it('does NOT wipe the expiry when the caller supplies none', async () => {
    await svc.connectAccount(WS, base);

    const call = (prisma.socialAccount.upsert as jest.Mock).mock.calls[0][0];
    // Absent, not null: Prisma leaves the column alone. A null here would drop
    // the row out of the refresh cron's `tokenExpiresAt: { not: null }` query
    // permanently — the one value nothing recovers from.
    expect('tokenExpiresAt' in call.update).toBe(false);
  });

  it('writes the expiry when the caller does supply one', async () => {
    const at = new Date('2027-01-01T00:00:00.000Z');
    await svc.connectAccount(WS, { ...base, tokenExpiresAt: at });

    const call = (prisma.socialAccount.upsert as jest.Mock).mock.calls[0][0];
    expect(call.update.tokenExpiresAt).toEqual(at);
  });
});
