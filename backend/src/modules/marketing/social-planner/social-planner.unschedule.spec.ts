// connectAccount refuses outright when the secret box is unconfigured, and
// MARKETING_SECRET_KEY is absent in CI but usually present in a developer's
// .env — so without this the repair-semantics tests below pass locally and fail
// on CI. Seal is a marker, not real crypto: these assert the SHAPE of the
// upsert, never the ciphertext.
jest.mock('../../../common/crypto/secret-box.helper', () => ({
  ...jest.requireActual('../../../common/crypto/secret-box.helper'),
  isSecretBoxConfigured: () => true,
  sealSecret: (v: string) => `sealed:${v}`,
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialPlannerService, PUBLISHING_STUCK_MS } from './social-planner.service';
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
    // The reset is a compare-and-set (updateMany + count check) inside one
    // transaction; `count: 1` is "nothing changed underneath me, the flip won".
    prisma.socialPost.updateMany?.mockResolvedValue({ count: 1 } as any);
    prisma.socialPostTarget.updateMany?.mockResolvedValue({ count: 1 } as any);
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
  });

  const scheduled = { id: 'p1', status: 'SCHEDULED' };

  it('returns the post to DRAFT and clears its send time', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(scheduled as any);
    jest.spyOn(svc, 'getPost').mockResolvedValue({ id: 'p1', status: 'DRAFT' } as never);

    await svc.unschedulePost(WS, 'p1');

    expect(prisma.socialPost.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', workspaceId: WS, status: 'SCHEDULED' },
      data: { status: 'DRAFT', scheduledAt: null },
    });
  });

  it('revives the not-yet-published targets on the way back to draft', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(scheduled as any);
    jest.spyOn(svc, 'getPost').mockResolvedValue({} as never);

    await svc.unschedulePost(WS, 'p1');

    // Uniform across every accepted status, not just the retry path: whatever
    // the post is about to be re-sent as, the correct state for a target that
    // never went out is PENDING with no stale error from an earlier attempt.
    expect(prisma.socialPostTarget.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, postId: 'p1', status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'PENDING', error: null },
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
    prisma.socialPost.updateMany?.mockImplementation(async () => {
      order.push('update');
      return { count: 1 } as any;
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
    expect(prisma.socialPost.updateMany).not.toHaveBeenCalled();
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
 * A FAILED post used to be TERMINAL, and that was the bug.
 *
 * `publishNow` and `schedulePost` both refuse anything outside DRAFT/SCHEDULED,
 * `updatePost` is DRAFT-only, and `unschedulePost` was SCHEDULED-only — so a
 * post that failed for an entirely transient reason (an expired page token, a
 * 500 from the network) had exactly one exit: DELETE and recompose. The
 * operator lost the caption, the media and the chosen accounts to a blip.
 *
 * The dangerous half of the fix is the target reset. A post's status is
 * per-post but its outcome is per-network, so a post can carry PUBLISHED
 * targets alongside failed ones — and `publishDuePost` re-sends every PENDING
 * target it finds. Reviving the PUBLISHED ones would duplicate content that is
 * already live on the customer's own feed.
 */
describe('SocialPlannerService.unschedulePost — FAILED retry path', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let scheduledJobs: { schedule: jest.Mock; cancel: jest.Mock };
  let svc: SocialPlannerService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    scheduledJobs = { schedule: jest.fn(), cancel: jest.fn().mockResolvedValue(true) };
    svc = new SocialPlannerService(
      prisma as any,
      scheduledJobs as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    prisma.socialPost.update.mockResolvedValue({} as any);
    prisma.socialPost.updateMany?.mockResolvedValue({ count: 1 } as any);
    prisma.socialPostTarget.updateMany?.mockResolvedValue({ count: 1 } as any);
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
    jest.spyOn(svc, 'getPost').mockResolvedValue({ id: 'p1', status: 'DRAFT' } as never);
  });

  const failed = { id: 'p1', status: 'FAILED', updatedAt: new Date() };

  it('resets a FAILED post to DRAFT instead of forcing a delete-and-retype', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(failed as any);

    await svc.unschedulePost(WS, 'p1');

    expect(prisma.socialPost.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', workspaceId: WS, status: 'FAILED' },
      data: { status: 'DRAFT', scheduledAt: null },
    });
  });

  it('revives ONLY the PENDING and FAILED targets — an already-live target must never re-post', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(failed as any);

    await svc.unschedulePost(WS, 'p1');

    const where = (prisma.socialPostTarget.updateMany as jest.Mock).mock.calls[0][0].where;
    // The PUBLISHED targets are excluded by the filter, so the next publish
    // skips them: no duplicate post on the network that already received it.
    expect(where.status).toEqual({ in: ['PENDING', 'FAILED'] });
    expect(where).toEqual({ workspaceId: WS, postId: 'p1', status: { in: ['PENDING', 'FAILED'] } });
  });

  it('clears the stale error on the revived targets', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(failed as any);

    await svc.unschedulePost(WS, 'p1');

    expect((prisma.socialPostTarget.updateMany as jest.Mock).mock.calls[0][0].data).toEqual({
      status: 'PENDING',
      error: null,
    });
  });

  /**
   * The two writes used to be ordered targets-first, on the argument that a
   * crash in between should leave the recoverable partial state. They are now
   * ATOMIC instead, which is strictly better and is what makes the ordering
   * argument moot: neither partial state exists.
   *
   * It also stopped being a free choice. `attachTargets` no longer re-creates a
   * target row the post already has, so the partial state the old order ruled
   * out — a DRAFT whose targets are all still FAILED — would now be STICKY: the
   * operator re-selects the account, nothing is created because the FAILED row
   * is already there, and the post can never reach that network again.
   */
  it('does both writes in ONE transaction, flip first', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(failed as any);
    const order: string[] = [];
    (prisma.socialPostTarget.updateMany as jest.Mock).mockImplementation(async () => {
      order.push('targets');
      return { count: 1 } as any;
    });
    prisma.socialPost.updateMany?.mockImplementation(async () => {
      order.push('post');
      return { count: 1 } as any;
    });

    await svc.unschedulePost(WS, 'p1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Flip first so that LOSING the compare-and-set costs nothing: the target
    // revive is never even attempted for a post that changed underneath.
    expect(order).toEqual(['post', 'targets']);
  });

  /**
   * The status is read at the top of the method and written at the bottom. With
   * a bare `update` by id in between — which is what this was — a publish run
   * that is genuinely alive (the 30-minute "stuck" threshold is a heuristic, not
   * a lock) can finish in the gap and have its PUBLISHED post dragged back to
   * DRAFT. The operator is then looking at a draft for content that is live on
   * the customer's feed, and the obvious next move is to publish it again.
   */
  it('refuses when the post changed underneath, instead of clobbering it', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(failed as any);
    // The compare-and-set matched nothing: the row is no longer FAILED.
    prisma.socialPost.updateMany?.mockResolvedValue({ count: 0 } as any);

    await expect(svc.unschedulePost(WS, 'p1')).rejects.toThrow(BadRequestException);
    // And nothing else was written — the targets of a post that just went live
    // must not be reset to PENDING behind it.
    expect(prisma.socialPostTarget.updateMany).not.toHaveBeenCalled();
  });

  it('pins the compare-and-set to the status it actually read', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(failed as any);

    await svc.unschedulePost(WS, 'p1');

    // Without `status` in the WHERE the write is unconditional and the race
    // above is unwinnable; without `workspaceId` it is a cross-tenant write.
    const where = (prisma.socialPost.updateMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toEqual({ id: 'p1', workspaceId: WS, status: 'FAILED' });
  });

  it('scopes the target reset to the caller workspace', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(failed as any);

    await svc.unschedulePost(WS, 'p1');

    // updateMany addresses many rows: an unscoped where here is a cross-tenant
    // write, not merely a leak.
    expect(
      (prisma.socialPostTarget.updateMany as jest.Mock).mock.calls[0][0].where.workspaceId,
    ).toBe(WS);
  });

  it('never touches a post in another workspace', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(null);

    await expect(svc.unschedulePost('ws-other', 'p1')).rejects.toThrow(NotFoundException);
    expect(prisma.socialPostTarget.updateMany).not.toHaveBeenCalled();
    expect(prisma.socialPost.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * PUBLISHING is the one status where the reset is genuinely dangerous: it means
 * a run holds the row right now, and resetting under a live run is how a post
 * gets sent twice. A run that DIED mid-fan-out leaves the identical status with
 * nobody holding it, and the post is then unreachable by every route.
 *
 * The threshold is what separates the two, and it is deliberately double the
 * scheduled-job runner's 15-minute stale-lock reaper window: the automatic
 * recovery gets a full cycle to finish the publish properly before a human is
 * offered the manual unstick.
 */
describe('SocialPlannerService.unschedulePost — stuck PUBLISHING', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let scheduledJobs: { schedule: jest.Mock; cancel: jest.Mock };
  let svc: SocialPlannerService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    scheduledJobs = { schedule: jest.fn(), cancel: jest.fn().mockResolvedValue(true) };
    svc = new SocialPlannerService(
      prisma as any,
      scheduledJobs as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    prisma.socialPost.update.mockResolvedValue({} as any);
    prisma.socialPost.updateMany?.mockResolvedValue({ count: 1 } as any);
    prisma.socialPostTarget.updateMany?.mockResolvedValue({ count: 1 } as any);
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
    jest.spyOn(svc, 'getPost').mockResolvedValue({ id: 'p1' } as never);
  });

  const publishing = (ageMs: number) => ({
    id: 'p1',
    status: 'PUBLISHING',
    updatedAt: new Date(Date.now() - ageMs),
  });

  it('refuses a post that is publishing RIGHT NOW', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(publishing(1_000) as any);

    await expect(svc.unschedulePost(WS, 'p1')).rejects.toThrow(BadRequestException);
    // Nothing was cancelled and no target was moved — the live run keeps the
    // row exactly as it found it.
    expect(scheduledJobs.cancel).not.toHaveBeenCalled();
    expect(prisma.socialPostTarget.updateMany).not.toHaveBeenCalled();
    expect(prisma.socialPost.updateMany).not.toHaveBeenCalled();
  });

  it('still refuses one minute short of the threshold', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(publishing(PUBLISHING_STUCK_MS - 60_000) as any);

    await expect(svc.unschedulePost(WS, 'p1')).rejects.toThrow(BadRequestException);
  });

  it('accepts a run that has been silent past the threshold', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(publishing(PUBLISHING_STUCK_MS + 60_000) as any);

    await svc.unschedulePost(WS, 'p1');

    expect(prisma.socialPost.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', workspaceId: WS, status: 'PUBLISHING' },
      data: { status: 'DRAFT', scheduledAt: null },
    });
    // Same target discipline as the FAILED path: a target that already went out
    // during the crashed run is left PUBLISHED and will not be re-sent.
    expect(prisma.socialPostTarget.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['PENDING', 'FAILED'] } }),
      }),
    );
  });

  it('fails CLOSED when the row carries no readable updatedAt', async () => {
    // A NaN age must not read as "infinitely stale" — guessing wrong in that
    // direction publishes the post a second time.
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'PUBLISHING',
      updatedAt: undefined,
    } as any);

    await expect(svc.unschedulePost(WS, 'p1')).rejects.toThrow(BadRequestException);
    expect(prisma.socialPost.updateMany).not.toHaveBeenCalled();
  });

  it('cancels the revived queue job before resetting the row', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(publishing(PUBLISHING_STUCK_MS + 60_000) as any);

    await svc.unschedulePost(WS, 'p1');

    // By 30 minutes the runner's reaper has put the job back to PENDING, which
    // is the only state `cancel` can act on — the other half of why the
    // threshold sits above the reaper window. (A post stuck by `publishNow` has
    // no ScheduledJob row at all, so there this call can never do anything and
    // the compare-and-set below is the whole protection.)
    expect(scheduledJobs.cancel).toHaveBeenCalledWith(expect.any(String), 'social-post-p1');
  });

  /**
   * The dangerous version of the race, and the reason the flip is a
   * compare-and-set: "stuck" is a 30-minute idle heuristic, and on the
   * `publishNow` path nothing reaps the row, so a slow-but-alive fan-out may
   * still be holding it. If that run completes between the read at the top of
   * the method and the write at the bottom, an unconditional update turns a
   * PUBLISHED post back into a DRAFT — and the operator's next move is to send
   * content that is already live a second time.
   */
  it('will not clobber a run that finished while the reset was in flight', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(publishing(PUBLISHING_STUCK_MS + 60_000) as any);
    // By the time the write lands the row is PUBLISHED, so the WHERE's
    // `status: 'PUBLISHING'` matches nothing.
    prisma.socialPost.updateMany?.mockResolvedValue({ count: 0 } as any);

    await expect(svc.unschedulePost(WS, 'p1')).rejects.toThrow(BadRequestException);
    expect(prisma.socialPostTarget.updateMany).not.toHaveBeenCalled();
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

/**
 * A disconnected account is not a publish target.
 *
 * disconnectAccount leaves `enabled: false` with a blanked access token when
 * the account has publish history — the row stays so the history is still
 * readable (v2.199.0). attachTargets selected by id and workspace only, so one
 * of those could still be attached, and the post was then guaranteed to fail:
 * the adapter gets an empty token and the target lands FAILED at publish time,
 * long after the user was told it was queued.
 *
 * Worse through social-campaigns, which claims the item PUBLISHED *before*
 * handing off (a deliberate idempotency guard) — so the campaign reported a
 * published item for a post that never went out.
 */
describe('SocialPlannerService — publish targets must be connected', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: SocialPlannerService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    prisma.socialPostTarget.createMany?.mockResolvedValue({ count: 1 } as any);
    /**
     * `attachTargets` now READS the surviving targets before it creates any, so
     * an account that already published cannot be re-attached as PENDING and
     * published to twice. The shared deep mock leaves an unstubbed `findMany`
     * returning `undefined` rather than an empty list, which throws inside the
     * method under test and has nothing to do with what these two cases are
     * about — so the default is stated here.
     *
     * Empty is also the honest default for this block: it describes a post that
     * has no targets yet, which is exactly when attachTargets is called.
     */
    prisma.socialPostTarget.findMany?.mockResolvedValue([] as any);
    svc = new SocialPlannerService(
      prisma as any,
      { schedule: jest.fn(), cancel: jest.fn() } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
  });

  const attach = (ids: string[]) => (svc as any).attachTargets(WS, 'p1', ids);

  it('queries only enabled accounts', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([{ id: 'a1', network: 'INSTAGRAM' }] as any);

    await attach(['a1']);

    expect(prisma.socialAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ enabled: true }) }),
    );
  });

  it('still attaches the accounts that DO work when one has been disconnected', async () => {
    // A campaign's stored targetAccountIds go stale over time; it should keep
    // publishing to what is left rather than halting.
    prisma.socialAccount.findMany.mockResolvedValue([{ id: 'a1', network: 'INSTAGRAM' }] as any);

    await attach(['a1', 'disconnected-a2']);

    expect(prisma.socialPostTarget.createMany).toHaveBeenCalled();
  });

  it('refuses when NO selected account is usable, instead of queueing a post that cannot publish', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([] as any);

    await expect(attach(['disconnected-a2'])).rejects.toThrow(BadRequestException);
    expect(prisma.socialPostTarget.createMany).not.toHaveBeenCalled();
  });
});
