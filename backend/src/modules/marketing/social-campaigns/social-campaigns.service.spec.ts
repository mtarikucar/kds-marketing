import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  SocialCampaignsService,
  SOCIAL_CAMPAIGN_PLAN_KIND,
  SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND,
  planDedup,
} from './social-campaigns.service';
import { BrandSafetyService } from '../ai/brand-safety.service';
import { CampaignItemArmingService } from './campaign-item-arming.service';

const WS = 'ws-1';

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Launch', goal: 'awareness', theme: 'summer',
    brief: { audience: 'SMBs', topics: ['t1', 't2'] }, status: 'DRAFT',
    automationMode: 'APPROVAL', planningMode: 'AI_FULL',
    cadence: { daysOfWeek: [1, 3], timeOfDay: '09:00', timezone: 'UTC' },
    startDate: new Date('2026-07-01T00:00:00Z'), endDate: null,
    targetAccountIds: ['acc-1'], mediaKinds: ['IMAGE'], dailyPublishCap: 2,
    defaultImageModel: null, defaultVideoModel: null, createdById: 'u-1', stats: null,
    ...over,
  };
}

function build() {
  const prisma: any = {
    socialCampaign: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    socialCampaignItem: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
    socialPost: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    generatedAsset: { findMany: jest.fn().mockResolvedValue([]) },
    brandKit: { findUnique: jest.fn() },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1'), cancel: jest.fn().mockResolvedValue(true) };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn() };
  const planner = { schedulePost: jest.fn() };
  const anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn() };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn() };
  // The REAL arming service, on the same prisma/scheduledJobs fakes: the
  // post-generation branch is a shared autonomy rule now, and a stub here would
  // stop these tests from checking the rule they were written to check.
  const arming = new CampaignItemArmingService(prisma, scheduledJobs as any);
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any,
    // The REAL brand-safety screen on the same anthropic/credits fakes. It is
    // one shared service now (the community publisher uses the same instance),
    // and a stub here would stop these tests checking the screen they were
    // written to check.
    new BrandSafetyService(anthropic as any, credits as any),
    mediaGen as any,
    arming,
  );
  return { svc, prisma, scheduledJobs, runner, contentAi, planner, anthropic, credits, mediaGen };
}

describe('SocialCampaignsService — lifecycle + plan confirm', () => {
  it('registers the three job kinds on init', () => {
    const { svc, runner } = build();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(SOCIAL_CAMPAIGN_PLAN_KIND, expect.any(Function));
    expect(runner.registerHandler).toHaveBeenCalledWith(SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, expect.any(Function));
    expect(runner.registerHandler).toHaveBeenCalledTimes(3);
  });

  it('activate DRAFT → ACTIVE and enqueues the planner with a stable dedupKey', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'DRAFT' }));
    prisma.socialCampaign.update.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    await svc.activate(WS, 'c-1');
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'ACTIVE' } });
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_PLAN_KIND, dedupKey: planDedup('c-1'),
      payload: { campaignId: 'c-1', workspaceId: WS },
    }));
  });

  it('listItems enriches each item with its caption + media (batched, workspace-scoped)', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findMany.mockResolvedValue([
      { id: 'it-1', socialCampaignId: 'c-1', workspaceId: WS, sequenceIndex: 0, status: 'SCHEDULED', topic: 'Summer', socialPostId: 'post-1', generatedAssetIds: ['a-1'], error: null },
      { id: 'it-2', socialCampaignId: 'c-1', workspaceId: WS, sequenceIndex: 1, status: 'PLANNED', topic: 'Teaser', socialPostId: null, generatedAssetIds: [], error: null },
    ]);
    prisma.socialPost.findMany.mockResolvedValue([{ id: 'post-1', content: 'Big summer sale!', mediaUrls: ['u'], publishedAt: null }]);
    prisma.generatedAsset.findMany.mockResolvedValue([{ id: 'a-1', type: 'IMAGE', status: 'READY', url: 'http://img', thumbnailUrl: 'http://thumb', mime: 'image/jpeg' }]);

    const out: any[] = await svc.listItems(WS, 'c-1');

    expect(out[0].caption).toBe('Big summer sale!');
    expect(out[0].media).toEqual([{ id: 'a-1', type: 'IMAGE', status: 'READY', url: 'http://img', thumbnailUrl: 'http://thumb', mime: 'image/jpeg' }]);
    // A PLANNED item with no post/assets yields clean nulls/empties.
    expect(out[1].caption).toBeNull();
    expect(out[1].media).toEqual([]);
    // Batched: exactly one post query + one asset query (no N+1), workspace-scoped.
    expect(prisma.socialPost.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.generatedAsset.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.socialPost.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ['post-1'] }, workspaceId: WS });
    expect(prisma.generatedAsset.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ['a-1'] }, workspaceId: WS });
  });

  it('activate rejects from a terminal status', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'CANCELLED' }));
    await expect(svc.activate(WS, 'c-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pause → PAUSED and cancels the planner job', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    prisma.socialCampaign.update.mockResolvedValueOnce(makeCampaign({ status: 'PAUSED' }));
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'PAUSED' }));
    await svc.pause(WS, 'c-1');
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'PAUSED' } });
    expect(scheduledJobs.cancel).toHaveBeenCalledWith(SOCIAL_CAMPAIGN_PLAN_KIND, planDedup('c-1'));
  });

  it('confirmPlan fans out generation for PLANNED items with a topic', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce({ id: 'c-1', planningMode: 'AI_PROPOSE' });
    prisma.socialCampaignItem.findMany.mockResolvedValueOnce([{ id: 'i-1' }, { id: 'i-2' }]);
    const res = await svc.confirmPlan(WS, 'c-1');
    expect(res).toEqual({ confirmed: 2 });
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(2);
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, payload: { itemId: 'i-1', workspaceId: WS },
    }));
  });

  it('get throws NotFound for a cross-workspace id', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(null);
    await expect(svc.get(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SocialCampaignsService — editable modes after activation', () => {
  it('allows a mode-only PATCH on an ACTIVE campaign (no item mid-generation)', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    prisma.socialCampaignItem.count.mockResolvedValueOnce(0);
    prisma.socialCampaign.update.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE', automationMode: 'FULL_AUTO' }));

    await svc.update(WS, 'c-1', { automationMode: 'FULL_AUTO' });

    expect(prisma.socialCampaignItem.count).toHaveBeenCalledWith({
      where: { socialCampaignId: 'c-1', status: 'GENERATING' },
    });
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c-1' },
      data: expect.objectContaining({ automationMode: 'FULL_AUTO' }),
    }));
  });

  it('rejects a mode-only PATCH on ACTIVE when an item is GENERATING', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    prisma.socialCampaignItem.count.mockResolvedValueOnce(1);

    await expect(svc.update(WS, 'c-1', { planningMode: 'AI_FULL' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
  });

  it('rejects a mode-only PATCH on a COMPLETED campaign', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'COMPLETED' }));

    await expect(svc.update(WS, 'c-1', { automationMode: 'SEMI_AUTO' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaignItem.count).not.toHaveBeenCalled();
    expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
  });

  it('still rejects a non-mode field PATCH on an ACTIVE campaign', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));

    await expect(svc.update(WS, 'c-1', { name: 'Renamed', automationMode: 'FULL_AUTO' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaignItem.count).not.toHaveBeenCalled();
    expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
  });
});

/**
 * The campaign's model override, refused where it is CHOSEN.
 *
 * `defaultImageModel` / `defaultVideoModel` are the first term of
 * `campaign override ?? workspace default ?? code constant`, and the columns
 * took any string at all. The failure that shape produces is not "a bad id" —
 * it is every item of the campaign failing at generation time, hours later, on
 * the scheduled-job path, with the reason on an item row instead of on the form
 * where the choice was made. `ConceptPromotionService.produce` turns it into
 * "clip 1/5 could not be generated" on a FAILED item, over and over.
 */
describe('SocialCampaignsService — the model override is checked at the write', () => {
  const INPUT = {
    name: 'Launch', brief: {}, automationMode: 'APPROVAL' as const,
    planningMode: 'AI_FULL' as const,
    cadence: { daysOfWeek: [1], timeOfDay: '09:00' } as never,
    startDate: new Date(), targetAccountIds: ['acc-1'], mediaKinds: ['VIDEO'],
    createdById: 'u-1',
  };

  it('refuses an uncatalogued video model on create, and never writes the row', async () => {
    const { svc, prisma } = build();
    await expect(
      svc.create(WS, { ...INPUT, defaultVideoModel: 'fal-ai/some-new-thing' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaign.create).not.toHaveBeenCalled();
  });

  /**
   * The one a picker actually produces. `fal-ai/qwen-image` IS catalogued — as
   * an IMAGE model — and the two kinds bill in different units, so accepting it
   * as the video default is not a mislabel, it is a clip priced at the flat
   * per-image rate. Same question `isCataloguedModel` asks everywhere else.
   */
  it('refuses a catalogued id of the WRONG KIND', async () => {
    const { svc, prisma } = build();
    await expect(
      svc.create(WS, { ...INPUT, defaultVideoModel: 'fal-ai/qwen-image' }),
    ).rejects.toThrow(/not a catalogued video model/);
    await expect(
      svc.create(WS, {
        ...INPUT,
        defaultImageModel: 'fal-ai/bytedance/seedance/v1/lite/text-to-video',
      }),
    ).rejects.toThrow(/not a catalogued image model/);
    expect(prisma.socialCampaign.create).not.toHaveBeenCalled();
  });

  /** The same sentence the workspace-level card gives, because it is the same
   *  function — the person is choosing between the same five options either
   *  way, and the message is what lists them. */
  it('names the options a caller may choose instead', async () => {
    const { svc } = build();
    await expect(
      svc.create(WS, { ...INPUT, defaultVideoModel: 'nope' }),
    ).rejects.toThrow(/fal-ai\/veo3\/fast/);
  });

  it('accepts a catalogued id of the right kind — the guard is not always-refuse', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.create.mockResolvedValue(makeCampaign());
    await svc.create(WS, { ...INPUT, defaultVideoModel: 'fal-ai/veo3/fast' });
    expect(prisma.socialCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ defaultVideoModel: 'fal-ai/veo3/fast' }),
      }),
    );
  });

  it('refuses on update too, before the campaign is even read', async () => {
    const { svc, prisma } = build();
    await expect(
      svc.update(WS, 'c-1', { defaultVideoModel: 'fal-ai/qwen-image' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaign.findFirst).not.toHaveBeenCalled();
    expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
  });

  /** Clearing the override back to the workspace default is not a bad id. */
  it('lets an update clear the override', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValue(makeCampaign({ status: 'DRAFT' }));
    prisma.socialCampaign.update.mockResolvedValue(makeCampaign());
    await svc.update(WS, 'c-1', { defaultVideoModel: null as never });
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ defaultVideoModel: null }),
      }),
    );
  });
});
