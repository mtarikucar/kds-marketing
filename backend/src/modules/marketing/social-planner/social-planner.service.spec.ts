import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SocialPlannerService, SOCIAL_PUBLISH_KIND } from './social-planner.service';
import * as networkAdapters from './network-adapters';
import * as secretBox from '../../../common/crypto/secret-box.helper';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<any> = {}) {
  return {
    id: 'acc-1',
    workspaceId: 'ws-a',
    network: 'FACEBOOK',
    externalId: 'page-1',
    displayName: 'Test Page',
    accessToken: 'v1:sealed-token',
    tokenExpiresAt: null,
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function makePost(overrides: Partial<any> = {}) {
  return {
    id: 'post-1',
    workspaceId: 'ws-a',
    content: 'Hello world',
    mediaUrls: [],
    status: 'DRAFT',
    scheduledAt: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    targets: [],
    ...overrides,
  };
}

function makeTarget(overrides: Partial<any> = {}) {
  return {
    id: 'tgt-1',
    workspaceId: 'ws-a',
    postId: 'post-1',
    socialAccountId: 'acc-1',
    network: 'FACEBOOK',
    status: 'PENDING',
    externalPostId: null,
    error: null,
    account: makeAccount(),
    ...overrides,
  };
}

// ── spec ──────────────────────────────────────────────────────────────────────

describe('SocialPlannerService', () => {
  let svc: SocialPlannerService;
  let prisma: any;
  let scheduledJobs: any;
  let runner: any;
  let credits: any;

  beforeEach(() => {
    prisma = {
      socialPost: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      socialAccount: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
      },
      socialPostTarget: {
        createMany: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        update: jest.fn(),
      },
    };
    scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
    runner = { registerHandler: jest.fn() };
    const r2 = { isConfigured: () => false, upload: jest.fn(), deleteKeys: jest.fn() };
    credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };

    svc = new SocialPlannerService(prisma as any, scheduledJobs as any, runner as any, r2 as any, credits as any);
  });

  // ── onModuleInit ──────────────────────────────────────────────────────────

  it('registers the social.publish handler on init', () => {
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(
      SOCIAL_PUBLISH_KIND,
      expect.any(Function),
    );
  });

  // ── schedulePost ──────────────────────────────────────────────────────────

  it('schedulePost sets status=SCHEDULED and enqueues a ScheduledJob with the right kind + dedupKey', async () => {
    const scheduledAt = new Date('2026-08-01T10:00:00.000Z');
    const postWithTargets = {
      ...makePost({ status: 'DRAFT' }),
      targets: [makeTarget()],
    };

    prisma.socialPost.findFirst
      .mockResolvedValueOnce(postWithTargets) // initial find
      .mockResolvedValueOnce({ ...postWithTargets, status: 'SCHEDULED', scheduledAt }); // getPost after update
    prisma.socialPostTarget.findMany.mockResolvedValue([makeTarget()]);
    prisma.socialPost.update.mockResolvedValue({ ...postWithTargets, status: 'SCHEDULED' });

    await svc.schedulePost('ws-a', 'post-1', scheduledAt);

    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
        data: expect.objectContaining({ status: 'SCHEDULED', scheduledAt }),
      }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      kind: SOCIAL_PUBLISH_KIND,
      runAt: scheduledAt,
      payload: { postId: 'post-1', workspaceId: 'ws-a' },
      dedupKey: 'social-post-post-1',
    });
  });

  it('schedulePost throws BadRequest when no targets exist', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(makePost({ status: 'DRAFT', targets: [] }));
    prisma.socialPostTarget.findMany.mockResolvedValue([]);

    await expect(
      svc.schedulePost('ws-a', 'post-1', new Date()),
    ).rejects.toThrow(BadRequestException);
  });

  // ── createPost options ─────────────────────────────────────────────────────

  it('createPost persists options.linkedin.visibility into SocialPost.options alongside formats', async () => {
    prisma.socialPost.create.mockResolvedValue(makePost({ id: 'post-1' }));
    prisma.socialPost.findFirst.mockResolvedValue(makePost({ id: 'post-1', targets: [] }));

    await svc.createPost('ws-a', {
      content: 'hello',
      formats: { 'acc-1': 'FEED' },
      options: { linkedin: { visibility: 'CONNECTIONS' } },
    });

    const created = prisma.socialPost.create.mock.calls[0][0];
    expect(created.data.options.linkedin).toEqual({ visibility: 'CONNECTIONS' });
    expect(created.data.options.formats).toEqual({ 'acc-1': 'FEED' });
  });

  it('updatePost persists options.linkedin.visibility and preserves existing formats', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(
      makePost({ id: 'post-1', status: 'DRAFT', options: { formats: { 'acc-1': 'FEED' } } }),
    );
    prisma.socialPost.update.mockResolvedValue(makePost({ id: 'post-1' }));

    await svc.updatePost('ws-a', 'post-1', {
      options: { linkedin: { visibility: 'PUBLIC' } },
    });

    const updated = prisma.socialPost.update.mock.calls[0][0];
    expect(updated.data.options.linkedin).toEqual({ visibility: 'PUBLIC' });
    expect(updated.data.options.formats).toEqual({ 'acc-1': 'FEED' });
  });

  it('updatePost replaces the draft PENDING targets when targetAccountIds is provided', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(
      makePost({ id: 'post-1', status: 'DRAFT', options: {} }),
    );
    prisma.socialPost.update.mockResolvedValue(makePost({ id: 'post-1' }));
    prisma.socialAccount.findMany.mockResolvedValue([
      makeAccount({ id: 'acc-2', network: 'INSTAGRAM' }),
    ]);
    prisma.socialPostTarget.createMany.mockResolvedValue({ count: 1 });

    await svc.updatePost('ws-a', 'post-1', { targetAccountIds: ['acc-2'] });

    // Old PENDING targets removed, then the new set attached — so a draft target
    // edit persists WITHOUT needing to also schedule.
    expect(prisma.socialPostTarget.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-a', postId: 'post-1', status: 'PENDING' },
    });
    expect(prisma.socialPostTarget.createMany).toHaveBeenCalled();
  });

  it('updatePost leaves targets untouched when targetAccountIds is omitted', async () => {
    prisma.socialPost.findFirst.mockResolvedValue(
      makePost({ id: 'post-1', status: 'DRAFT', options: {} }),
    );
    prisma.socialPost.update.mockResolvedValue(makePost({ id: 'post-1' }));

    await svc.updatePost('ws-a', 'post-1', { content: 'x' });

    expect(prisma.socialPostTarget.deleteMany).not.toHaveBeenCalled();
    expect(prisma.socialPostTarget.createMany).not.toHaveBeenCalled();
  });

  it('publishDuePost forwards post.options.linkedin to publishToNetwork opts', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: true, externalPostId: 'ext-li' });

    const liTarget = makeTarget({
      id: 'tgt-li',
      network: 'LINKEDIN',
      account: makeAccount({ id: 'acc-li', network: 'LINKEDIN' }),
    });
    const postWithTargets = {
      ...makePost({ status: 'SCHEDULED', options: { linkedin: { visibility: 'CONNECTIONS' } } }),
      targets: [liTarget],
    };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(mockPublish).toHaveBeenCalledWith(
      liTarget.account,
      'Hello world',
      [],
      expect.objectContaining({ linkedin: { visibility: 'CONNECTIONS' } }),
    );

    mockPublish.mockRestore();
  });

  // ── publishDuePost ─────────────────────────────────────────────────────────

  it('publishDuePost fans out to all PENDING targets and records externalPostId on success', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: true, externalPostId: 'ext-123' });

    const postWithTargets = {
      ...makePost({ status: 'SCHEDULED' }),
      targets: [makeTarget(), makeTarget({ id: 'tgt-2', network: 'LINKEDIN', account: makeAccount({ id: 'acc-2', network: 'LINKEDIN' }) })],
    };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED', externalPostId: 'ext-123' }),
      }),
    );
    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );

    mockPublish.mockRestore();
  });

  it('publishDuePost: a crash-retry with targets already PUBLISHED (post stuck PUBLISHING) marks it PUBLISHED, not FAILED', async () => {
    const mockPublish = jest.spyOn(networkAdapters, 'publishToNetwork').mockResolvedValue({ ok: true, externalPostId: 'x' });
    // The 15-min reaper re-ran the handler after a crash that published every
    // target but died before the post status update: targets already PUBLISHED,
    // post still PUBLISHING, nothing PENDING left. A this-run-only count would
    // be 0 and wrongly re-mark this live post FAILED.
    const postWithTargets = {
      ...makePost({ status: 'PUBLISHING' }),
      targets: [
        makeTarget({ id: 't1', status: 'PUBLISHED' }),
        makeTarget({ id: 't2', network: 'LINKEDIN', status: 'PUBLISHED', account: makeAccount({ id: 'acc-2', network: 'LINKEDIN' }) }),
      ],
    };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(mockPublish).not.toHaveBeenCalled(); // nothing PENDING to publish
    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED', publishedAt: expect.any(Date) }),
      }),
    );
    mockPublish.mockRestore();
  });

  it('publishDuePost marks a target FAILED with a clean error when network creds are unset', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockImplementation(async (account) => {
        if (account.network === 'FACEBOOK') {
          return { ok: false, error: 'Facebook not configured: set META_APP_ID and META_APP_SECRET' };
        }
        return { ok: true, externalPostId: 'ext-li-1' };
      });

    const fbTarget = makeTarget({ id: 'tgt-fb', network: 'FACEBOOK', account: makeAccount() });
    const liTarget = makeTarget({
      id: 'tgt-li',
      network: 'LINKEDIN',
      account: makeAccount({ id: 'acc-li', network: 'LINKEDIN' }),
    });
    const postWithTargets = { ...makePost({ status: 'SCHEDULED' }), targets: [fbTarget, liTarget] };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    // Facebook target → FAILED
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tgt-fb' },
        data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('Facebook not configured') }),
      }),
    );
    // LinkedIn target → PUBLISHED
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tgt-li' },
        data: expect.objectContaining({ status: 'PUBLISHED', externalPostId: 'ext-li-1' }),
      }),
    );
    // Post → PUBLISHED (at least one succeeded)
    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );

    mockPublish.mockRestore();
  });

  it('publishDuePost marks post FAILED when ALL targets fail', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: false, error: 'network error' });

    const postWithTargets = { ...makePost({ status: 'SCHEDULED' }), targets: [makeTarget()] };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );

    mockPublish.mockRestore();
  });

  // ── X (Twitter) credit metering ───────────────────────────────────────────

  function twitterPost(content: string) {
    const twTarget = makeTarget({
      id: 'tgt-tw',
      network: 'TWITTER',
      account: makeAccount({ id: 'acc-tw', network: 'TWITTER' }),
    });
    return {
      ...makePost({ status: 'SCHEDULED', content }),
      targets: [twTarget],
    };
  }

  it('publishDuePost reserves exactly 2 credits for a plain-text TWITTER post', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: true, externalPostId: 'tw-1' });
    prisma.socialPost.findFirst.mockResolvedValue(twitterPost('Just a plain tweet'));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.reserve).toHaveBeenCalledWith('ws-a', 2);
    expect(credits.refund).not.toHaveBeenCalled();
    mockPublish.mockRestore();
  });

  it('publishDuePost reserves 20 credits for a TWITTER post containing a URL', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: true, externalPostId: 'tw-2' });
    prisma.socialPost.findFirst.mockResolvedValue(twitterPost('check https://example.com now'));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(credits.reserve).toHaveBeenCalledWith('ws-a', 20);
    expect(credits.refund).not.toHaveBeenCalled();
    mockPublish.mockRestore();
  });

  it('publishDuePost refunds the reserved credits when the TWITTER publish fails', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: false, error: 'twitter api 500' });
    prisma.socialPost.findFirst.mockResolvedValue(twitterPost('a failing tweet'));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(credits.reserve).toHaveBeenCalledWith('ws-a', 2);
    expect(credits.refund).toHaveBeenCalledWith('ws-a', 2);
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tgt-tw' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    mockPublish.mockRestore();
  });

  it('publishDuePost refunds the reserved credits exactly once when the TWITTER publish THROWS, and re-throws', async () => {
    const boom = new Error('twitter adapter exploded');
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockRejectedValue(boom);
    prisma.socialPost.findFirst.mockResolvedValue(twitterPost('a throwing tweet'));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    // The throw still propagates the same way it does today (no swallow).
    await expect(svc.publishDuePost('post-1', 'ws-a')).rejects.toThrow(boom);

    expect(credits.reserve).toHaveBeenCalledWith('ws-a', 2);
    // Refunded exactly once — the thrown-error path must not also reach the
    // returned-{ok:false} refund branch (no double-refund).
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(credits.refund).toHaveBeenCalledWith('ws-a', 2);
    mockPublish.mockRestore();
  });

  it('publishDuePost does NOT reserve/refund credits for non-Twitter targets', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: true, externalPostId: 'ext' });
    const postWithTargets = {
      ...makePost({ status: 'SCHEDULED' }),
      targets: [
        makeTarget({ id: 't-fb', network: 'FACEBOOK', account: makeAccount({ id: 'a-fb', network: 'FACEBOOK' }) }),
        makeTarget({ id: 't-ig', network: 'INSTAGRAM', account: makeAccount({ id: 'a-ig', network: 'INSTAGRAM' }) }),
        makeTarget({ id: 't-li', network: 'LINKEDIN', account: makeAccount({ id: 'a-li', network: 'LINKEDIN' }) }),
      ],
    };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(credits.reserve).not.toHaveBeenCalled();
    expect(credits.refund).not.toHaveBeenCalled();
    mockPublish.mockRestore();
  });

  it('publishDuePost marks the TWITTER target FAILED (not a crash) when credits are exhausted, and still publishes other targets', async () => {
    const mockPublish = jest
      .spyOn(networkAdapters, 'publishToNetwork')
      .mockResolvedValue({ ok: true, externalPostId: 'ext-fb' });
    credits.reserve.mockRejectedValue(
      new ForbiddenException({ code: 'AI_CREDITS_EXHAUSTED', message: 'Monthly AI credit limit reached (100)' }),
    );

    const twTarget = makeTarget({
      id: 'tgt-tw',
      network: 'TWITTER',
      account: makeAccount({ id: 'acc-tw', network: 'TWITTER' }),
    });
    const fbTarget = makeTarget({
      id: 'tgt-fb',
      network: 'FACEBOOK',
      account: makeAccount({ id: 'acc-fb', network: 'FACEBOOK' }),
    });
    const postWithTargets = {
      ...makePost({ status: 'SCHEDULED', content: 'tweet me' }),
      targets: [twTarget, fbTarget],
    };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    // Twitter target failed WITHOUT ever hitting the vendor, and surfaces the code
    expect(mockPublish).toHaveBeenCalledTimes(1); // only the FB target published
    expect(mockPublish).toHaveBeenCalledWith(fbTarget.account, 'tweet me', [], expect.any(Object));
    expect(credits.refund).not.toHaveBeenCalled(); // nothing was reserved → nothing to refund
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tgt-tw' },
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringContaining('AI_CREDITS_EXHAUSTED'),
        }),
      }),
    );
    // FB target still published, post ends PUBLISHED (at least one target live)
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tgt-fb' },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );
    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PUBLISHED' }) }),
    );
    mockPublish.mockRestore();
  });

  // ── cross-workspace isolation ─────────────────────────────────────────────

  it('getPost for a post belonging to another workspace returns NotFoundException', async () => {
    // Prisma would return null when workspaceId doesn't match
    prisma.socialPost.findFirst.mockResolvedValue(null);
    await expect(svc.getPost('ws-b', 'post-1')).rejects.toThrow(NotFoundException);
  });

  it('disconnectAccount for an account in another workspace returns NotFoundException', async () => {
    prisma.socialAccount.findFirst.mockResolvedValue(null);
    await expect(svc.disconnectAccount('ws-b', 'acc-1')).rejects.toThrow(NotFoundException);
  });

  // ── token sealing/masking ─────────────────────────────────────────────────

  it('connectAccount seals the token and the returned row masks it', async () => {
    jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
    const sealSpy = jest.spyOn(secretBox, 'sealSecret').mockReturnValue('v1:sealed');

    prisma.socialAccount.upsert.mockResolvedValue(makeAccount({ accessToken: 'v1:sealed' }));

    const result = await svc.connectAccount('ws-a', {
      network: 'FACEBOOK',
      externalId: 'page-1',
      displayName: 'Test',
      accessToken: 'raw-token-should-not-leak',
    });

    expect(sealSpy).toHaveBeenCalledWith('raw-token-should-not-leak');
    // The raw token must not appear in the response
    expect(JSON.stringify(result)).not.toContain('raw-token-should-not-leak');
    // It should be masked
    expect(result.accessToken).toMatch(/^••••/);

    sealSpy.mockRestore();
    (secretBox.isSecretBoxConfigured as jest.Mock).mockRestore?.();
  });

  it('connectAccount throws BadRequest when MARKETING_SECRET_KEY is not configured', async () => {
    jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(false);

    await expect(
      svc.connectAccount('ws-a', {
        network: 'FACEBOOK',
        externalId: 'page-1',
        displayName: 'Test',
        accessToken: 'raw-token',
      }),
    ).rejects.toThrow(BadRequestException);

    (secretBox.isSecretBoxConfigured as jest.Mock).mockRestore?.();
  });
});
