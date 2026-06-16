import { BadRequestException, NotFoundException } from '@nestjs/common';
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

    svc = new SocialPlannerService(prisma as any, scheduledJobs as any, runner as any);
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
