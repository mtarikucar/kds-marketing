import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  SocialPlannerService,
  SOCIAL_PUBLISH_KIND,
  SOCIAL_POSTS_MAX_PAGE,
} from './social-planner.service';
import { publishToNetwork } from './network-adapters';
import { isSecretBoxConfigured, sealSecret } from '../../../common/crypto/secret-box.helper';

// Module mocks (not jest.spyOn on the namespace objects): ESM->CJS emitters that
// define exports as non-configurable getters make namespace spying impossible.
// The secret-box fakes CALL THROUGH to the real implementation by default so
// the tests that never stubbed them (previously: unspied) are unchanged.
jest.mock('./network-adapters', () => ({
  ...jest.requireActual('./network-adapters'),
  publishToNetwork: jest.fn(),
}));
jest.mock('../../../common/crypto/secret-box.helper', () => ({
  ...jest.requireActual('../../../common/crypto/secret-box.helper'),
  isSecretBoxConfigured: jest.fn(),
  sealSecret: jest.fn(),
}));
const actualSecretBox = jest.requireActual<typeof import('../../../common/crypto/secret-box.helper')>(
  '../../../common/crypto/secret-box.helper',
);
const publishToNetworkMock = publishToNetwork as unknown as jest.Mock;
const isSecretBoxConfiguredMock = isSecretBoxConfigured as unknown as jest.Mock;
const sealSecretMock = sealSecret as unknown as jest.Mock;
beforeEach(() => {
  publishToNetworkMock.mockReset();
  isSecretBoxConfiguredMock.mockReset().mockImplementation(actualSecretBox.isSecretBoxConfigured);
  sealSecretMock.mockReset().mockImplementation(actualSecretBox.sealSecret);
});

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
    // A hand-composed post by default: nobody generated media FOR it.
    socialCampaignId: null,
    campaignItemId: null,
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
        // Defaults to "this post has no targets yet": attachTargets reads the
        // rows that survived the caller's deleteMany before it creates
        // anything, so every path through it needs this to resolve.
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
    const mockPublish = publishToNetworkMock
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

    mockPublish.mockReset();
  });

  // ── publishDuePost ─────────────────────────────────────────────────────────

  it('publishDuePost fans out to all PENDING targets and records externalPostId on success', async () => {
    const mockPublish = publishToNetworkMock
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

    mockPublish.mockReset();
  });

  /**
   * Defects 4, 7 and 8, at the publish end — where they are all one question.
   *
   * A five-beat concept generates five clips and is CHARGED for five. Facebook
   * and TikTok publish one, an Instagram feed carousel publishes all five, and X
   * publishes none. That is not a reason to refuse the concept (defect 7 was a
   * blanket refusal that cost the feature seven of the eight networks); it is a
   * reason to decide PER TARGET what that destination takes, and to say what it
   * left behind.
   */
  const FIVE_CLIPS = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4'];

  // A CAMPAIGN ITEM'S post: the five clips were planned, paid for and approved
  // AS this post, which is what `campaignItemId` records.
  const clipPost = (targets: any[]) => ({
    ...makePost({
      status: 'SCHEDULED',
      mediaUrls: [...FIVE_CLIPS],
      socialCampaignId: 'camp-1',
      campaignItemId: 'item-1',
    }),
    targets,
  });
  const targetOn = (network: string, id: string) =>
    makeTarget({
      id: `tgt-${id}`,
      network,
      socialAccountId: `acc-${id}`,
      account: makeAccount({ id: `acc-${id}`, network }),
    });

  it('publishDuePost hands ONE target only what its network carries, and says what it dropped', async () => {
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'ext-1' });
    prisma.socialPost.findFirst.mockResolvedValue(clipPost([makeTarget()])); // FACEBOOK
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    // One clip reached the adapter — the FIRST, which is the hook. Beat order is
    // the order the clips were bought in and must not be re-shuffled here.
    expect(mockPublish.mock.calls[0][2]).toEqual(['a.mp4']);
    const call = prisma.socialPostTarget.update.mock.calls.at(-1)[0];
    // PUBLISHED — the post is live. The note is what stops the loss being silent.
    expect(call.data.status).toBe('PUBLISHED');
    expect(call.data.error).toMatch(/4 of 5/);
    expect(call.data.error).toMatch(/FACEBOOK carries 1 video per post/);

    mockPublish.mockReset();
  });

  it('publishDuePost gives EACH target its own share of the same post', async () => {
    // The heart of defect 7's fix: one approved concept, two destinations, two
    // different — and both legitimate — publishes.
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'ext-1' });
    prisma.socialPost.findFirst.mockResolvedValue(
      clipPost([targetOn('INSTAGRAM', 'ig'), targetOn('TIKTOK', 'tt')]),
    );
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    // Instagram's feed carousel carries ten, so it gets the whole concept...
    expect(mockPublish.mock.calls[0][2]).toEqual(FIVE_CLIPS);
    // ...and TikTok gets the hook, in the plan's own order.
    expect(mockPublish.mock.calls[1][2]).toEqual(['a.mp4']);

    const rowFor = (id: string) =>
      prisma.socialPostTarget.update.mock.calls.find((c: any[]) => c[0].where.id === id)[0];
    expect(rowFor('tgt-ig').data.status).toBe('PUBLISHED');
    expect(rowFor('tgt-ig').data.error).toBeNull();
    expect(rowFor('tgt-tt').data.status).toBe('PUBLISHED');
    expect(rowFor('tgt-tt').data.error).toMatch(/4 of 5/);

    mockPublish.mockReset();
  });

  /**
   * DEFECT 8 — the one thing in this change that has to be airtight.
   *
   * `confirmItem` checks that the POST has media and then fans out to every
   * target without asking what any of them can carry. `publishTwitter` uploads
   * with `media_category: tweet_image`, so a video yields no media id and the
   * tweet went out as the caption ALONE with the target recorded PUBLISHED — a
   * post nobody approved, published under the name of one that was.
   */
  it('publishDuePost NEVER publishes a bare caption to a target that can carry no media', async () => {
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'tw-1' });
    prisma.socialPost.findFirst.mockResolvedValue(clipPost([targetOn('TWITTER', 'x')]));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    // The vendor is never called at all — nothing goes out.
    expect(mockPublish).not.toHaveBeenCalled();
    // ...and X's per-post charge is never reserved for a publish that never ran.
    expect(credits.reserve).not.toHaveBeenCalled();
    const call = prisma.socialPostTarget.update.mock.calls.at(-1)[0];
    expect(call.where.id).toBe('tgt-x');
    expect(call.data.status).toBe('FAILED');
    expect(call.data.error).toMatch(/TWITTER cannot carry video at all/);
    expect(call.data.error).toMatch(/caption/);
    // No target published, so the post itself is FAILED — not silently "live".
    expect(prisma.socialPost.update.mock.calls.at(-1)[0].data.status).toBe('FAILED');

    mockPublish.mockReset();
  });

  it('publishDuePost still publishes the OTHER targets when one can carry nothing', async () => {
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'ext-1' });
    prisma.socialPost.findFirst.mockResolvedValue(
      clipPost([targetOn('TWITTER', 'x'), targetOn('INSTAGRAM', 'ig')]),
    );
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0].network).toBe('INSTAGRAM');
    expect(prisma.socialPost.update.mock.calls.at(-1)[0].data.status).toBe('PUBLISHED');

    mockPublish.mockReset();
  });

  it('publishDuePost still publishes a TEXT-ONLY post to a network that carries no media', async () => {
    // The invariant is about a post MADE OF MEDIA. A caption-only post to X is
    // exactly what X is for, and refusing it would be the over-correction all
    // over again.
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'tw-1' });
    prisma.socialPost.findFirst.mockResolvedValue({
      ...makePost({ status: 'SCHEDULED', mediaUrls: [] }),
      targets: [targetOn('TWITTER', 'x')],
    });
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(prisma.socialPostTarget.update.mock.calls.at(-1)[0].data.status).toBe('PUBLISHED');

    mockPublish.mockReset();
  });

  /**
   * THE SAME SHAPE, TWO POSTS.
   *
   * A hand-composed post is words somebody wrote with a picture attached: if the
   * picture has nowhere to go on this network, the words are still worth
   * sending, which is the rule `publishTwitter` has always followed. A campaign
   * item's post IS its clips, and its caption alone is a post the reviewer never
   * approved. `campaignItemId` is the fact that separates them.
   */
  it('publishDuePost DOES publish a HAND-COMPOSED post whose media this network cannot carry', async () => {
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'tw-2' });
    prisma.socialPost.findFirst.mockResolvedValue({
      // Same five clips, same X target as the campaign case — only the
      // provenance differs, and `makePost` leaves campaignItemId null.
      ...makePost({ status: 'SCHEDULED', mediaUrls: [...FIVE_CLIPS] }),
      targets: [targetOn('TWITTER', 'x')],
    });
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    // The words go out...
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][2]).toEqual([]);
    const call = prisma.socialPostTarget.update.mock.calls.at(-1)[0];
    expect(call.data.status).toBe('PUBLISHED');
    // ...and the loss is on the record all the same.
    expect(call.data.error).toMatch(/5 of 5 media file\(s\) were not sent: TWITTER cannot carry video at all/);

    mockPublish.mockReset();
  });

  it('publishDuePost tells the adapter WHOSE post it is', async () => {
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'ext-1' });
    prisma.socialPost.findFirst.mockResolvedValue(clipPost([targetOn('INSTAGRAM', 'ig')]));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');
    expect(mockPublish.mock.calls[0][3]).toEqual(
      expect.objectContaining({ mediaGeneratedForPost: true }),
    );

    mockPublish.mockReset();

    // ...and the hand-composed one is not passed off as generated.
    const second = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'ext-2' });
    prisma.socialPost.findFirst.mockResolvedValue({
      ...makePost({ status: 'SCHEDULED', mediaUrls: ['a.jpg'] }),
      targets: [targetOn('INSTAGRAM', 'ig')],
    });

    await svc.publishDuePost('post-1', 'ws-a');
    expect(second.mock.calls[0][3]).toEqual(
      expect.objectContaining({ mediaGeneratedForPost: false }),
    );

    second.mockReset();
  });

  it("publishDuePost keeps the ADAPTER's own drop report alongside the selector's", async () => {
    // Two different limits, two different denominators: the selector trimmed the
    // post to what the network carries, and the adapter then reported what IT
    // could not send out of that. Folding them into one fraction would state a
    // number that is true of neither.
    const mockPublish = publishToNetworkMock.mockResolvedValue({
      ok: true,
      externalPostId: 'ext-1',
      droppedMedia: { count: 2, reason: 'a Facebook feed post carries one video and no other media' },
    });
    prisma.socialPost.findFirst.mockResolvedValue({
      ...makePost({ status: 'SCHEDULED', mediaUrls: [...FIVE_CLIPS, 'x.jpg', 'y.jpg'] }),
      targets: [makeTarget()],
    });
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    const err = prisma.socialPostTarget.update.mock.calls.at(-1)[0].data.error;
    expect(err).toMatch(/4 of 7 media file\(s\) were not sent: FACEBOOK carries 1 video per post/);
    expect(err).toMatch(/2 of 3 media file\(s\) were not sent: a Facebook feed post/);

    mockPublish.mockReset();
  });

  it('publishDuePost leaves the target error NULL when nothing was dropped', async () => {
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'ext-1' });
    const postWithTargets = { ...makePost({ status: 'SCHEDULED' }), targets: [makeTarget()] };
    prisma.socialPost.findFirst.mockResolvedValue(postWithTargets);
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    const call = prisma.socialPostTarget.update.mock.calls.at(-1)[0];
    expect(call.data.error).toBeNull();

    mockPublish.mockReset();
  });

  it('publishDuePost: a crash-retry with targets already PUBLISHED (post stuck PUBLISHING) marks it PUBLISHED, not FAILED', async () => {
    const mockPublish = publishToNetworkMock.mockResolvedValue({ ok: true, externalPostId: 'x' });
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
    mockPublish.mockReset();
  });

  it('publishDuePost marks a target FAILED with a clean error when network creds are unset', async () => {
    const mockPublish = publishToNetworkMock
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

    mockPublish.mockReset();
  });

  it('publishDuePost marks post FAILED when ALL targets fail', async () => {
    const mockPublish = publishToNetworkMock
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

    mockPublish.mockReset();
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
    const mockPublish = publishToNetworkMock
      .mockResolvedValue({ ok: true, externalPostId: 'tw-1' });
    prisma.socialPost.findFirst.mockResolvedValue(twitterPost('Just a plain tweet'));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.reserve).toHaveBeenCalledWith('ws-a', 2);
    expect(credits.refund).not.toHaveBeenCalled();
    mockPublish.mockReset();
  });

  it('publishDuePost reserves 20 credits for a TWITTER post containing a URL', async () => {
    const mockPublish = publishToNetworkMock
      .mockResolvedValue({ ok: true, externalPostId: 'tw-2' });
    prisma.socialPost.findFirst.mockResolvedValue(twitterPost('check https://example.com now'));
    prisma.socialPost.update.mockResolvedValue({});
    prisma.socialPostTarget.update.mockResolvedValue({});

    await svc.publishDuePost('post-1', 'ws-a');

    expect(credits.reserve).toHaveBeenCalledWith('ws-a', 20);
    expect(credits.refund).not.toHaveBeenCalled();
    mockPublish.mockReset();
  });

  it('publishDuePost refunds the reserved credits when the TWITTER publish fails', async () => {
    const mockPublish = publishToNetworkMock
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
    mockPublish.mockReset();
  });

  it('publishDuePost refunds the reserved credits exactly once when the TWITTER publish THROWS, and re-throws', async () => {
    const boom = new Error('twitter adapter exploded');
    const mockPublish = publishToNetworkMock
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
    mockPublish.mockReset();
  });

  it('publishDuePost does NOT reserve/refund credits for non-Twitter targets', async () => {
    const mockPublish = publishToNetworkMock
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
    mockPublish.mockReset();
  });

  it('publishDuePost marks the TWITTER target FAILED (not a crash) when credits are exhausted, and still publishes other targets', async () => {
    const mockPublish = publishToNetworkMock
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
    mockPublish.mockReset();
  });

  // ── listPosts filtering ───────────────────────────────────────────────────

  /**
   * `listPosts` was a bare unbounded findMany: no window, no status, no take.
   * Every caller — the planner screen, the MCP tool, the Growth Studio
   * one-screen — downloaded the workspace's entire posting history (each row
   * with its `targets`) to answer "what goes out today?". These tests pin BOTH
   * halves of the fix: the new filtering works, and the old no-argument call
   * still issues the query it always did apart from the missing cap.
   */
  describe('listPosts', () => {
    const call = () => prisma.socialPost.findMany.mock.calls[0][0];

    it('is unchanged for an argument-less call, except that it is now bounded', async () => {
      await svc.listPosts('ws-a');

      expect(call()).toEqual(
        expect.objectContaining({
          where: { workspaceId: 'ws-a' },
          include: { targets: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: SOCIAL_POSTS_MAX_PAGE,
        }),
      );
      // No scheduledAt predicate at all: an unfiltered list must still show the
      // drafts that have no send time.
      expect(call().where.scheduledAt).toBeUndefined();
    });

    it('filters on scheduledAt and orders forwards when a window is given', async () => {
      const from = new Date('2026-09-01T00:00:00.000Z');
      const to = new Date('2026-09-01T23:59:59.999Z');

      await svc.listPosts('ws-a', { from, to });

      expect(call().where).toEqual({ workspaceId: 'ws-a', scheduledAt: { gte: from, lte: to } });
      // A calendar reads forwards — the next thing to go out has to be the
      // FIRST row, not the last one after a client-side reverse.
      expect(call().orderBy).toEqual([{ scheduledAt: 'asc' }, { id: 'asc' }]);
    });

    it('accepts a half-open window', async () => {
      const from = new Date('2026-09-01T00:00:00.000Z');

      await svc.listPosts('ws-a', { from });

      expect(call().where.scheduledAt).toEqual({ gte: from });
      expect(call().orderBy).toEqual([{ scheduledAt: 'asc' }, { id: 'asc' }]);
    });

    it('filters by status without disturbing the default ordering', async () => {
      await svc.listPosts('ws-a', { status: 'FAILED' });

      expect(call().where).toEqual({ workspaceId: 'ws-a', status: 'FAILED' });
      expect(call().orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    /**
     * Neither sort column is unique. A bulk campaign schedules a dozen posts at
     * the same instant and an imported batch shares a `createdAt`, so without a
     * tiebreak Postgres may return tied rows in any order it likes — and at the
     * `take` boundary two identical requests can then disagree about which of
     * them made the page: a post that appears twice across two reads, or in
     * neither. The tiebreak has to follow the primary column's direction, or
     * the two halves of the sort disagree about which end of a tie is first.
     */
    it('breaks ties on id so the page boundary is deterministic', async () => {
      await svc.listPosts('ws-a', { from: new Date('2026-09-01T00:00:00.000Z') });
      expect(call().orderBy).toEqual([{ scheduledAt: 'asc' }, { id: 'asc' }]);

      prisma.socialPost.findMany.mockClear();
      await svc.listPosts('ws-a');
      expect(prisma.socialPost.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('honours a smaller limit', async () => {
      await svc.listPosts('ws-a', { limit: 20 });

      expect(call().take).toBe(20);
    });

    it('clamps a limit above the hard cap instead of serving an unbounded read', async () => {
      await svc.listPosts('ws-a', { limit: 10_000 });

      expect(call().take).toBe(SOCIAL_POSTS_MAX_PAGE);
    });

    it('refuses an inverted range rather than silently returning nothing', async () => {
      // An empty list reads to a model (and to a user) as "there are no posts",
      // which is a wrong answer; a refusal is recoverable.
      await expect(
        svc.listPosts('ws-a', {
          from: new Date('2026-09-02T00:00:00.000Z'),
          to: new Date('2026-09-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.socialPost.findMany).not.toHaveBeenCalled();
    });

    it('refuses an unparseable bound', async () => {
      await expect(svc.listPosts('ws-a', { from: new Date('nonsense') })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.socialPost.findMany).not.toHaveBeenCalled();
    });

    it('stays workspace-scoped whatever the filter', async () => {
      await svc.listPosts('ws-b', {
        from: new Date('2026-09-01T00:00:00.000Z'),
        status: 'SCHEDULED',
        limit: 5,
      });

      expect(call().where.workspaceId).toBe('ws-b');
    });
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
    isSecretBoxConfiguredMock.mockReturnValue(true);
    const sealSpy = sealSecretMock.mockReturnValue('v1:sealed');

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

    sealSpy.mockReset();
    isSecretBoxConfiguredMock.mockReset();
  });

  it('connectAccount throws BadRequest when MARKETING_SECRET_KEY is not configured', async () => {
    isSecretBoxConfiguredMock.mockReturnValue(false);

    await expect(
      svc.connectAccount('ws-a', {
        network: 'FACEBOOK',
        externalId: 'page-1',
        displayName: 'Test',
        accessToken: 'raw-token',
      }),
    ).rejects.toThrow(BadRequestException);

    isSecretBoxConfiguredMock.mockReset();
  });
});
