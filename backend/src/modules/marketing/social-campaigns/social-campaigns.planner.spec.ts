import {
  SocialCampaignsService, SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
} from './social-campaigns.service';

const WS = 'ws-1';

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Launch', goal: 'awareness', theme: 'summer',
    brief: { audience: 'SMBs', topics: ['User topic A', 'User topic B'] }, status: 'ACTIVE',
    automationMode: 'APPROVAL', planningMode: 'AI_FULL',
    cadence: { daysOfWeek: [1, 3, 5], timeOfDay: '09:00', timezone: 'UTC' },
    startDate: new Date('2026-07-01T00:00:00Z'), endDate: null,
    targetAccountIds: ['acc-1'], mediaKinds: ['IMAGE'], dailyPublishCap: 2,
    defaultImageModel: 'fal-ai/qwen-image', defaultVideoModel: null, createdById: 'u-1', stats: null,
    ...over,
  };
}

function build() {
  const prisma: any = {
    socialCampaign: { findFirst: jest.fn(), findUnique: jest.fn().mockResolvedValue({ stats: null }), update: jest.fn() },
    socialCampaignItem: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    socialPost: { create: jest.fn().mockResolvedValue({ id: 'post-1' }) },
    brandKit: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('j'), cancel: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn().mockResolvedValue({ body: 'AI topic line\nrest' }) };
  const planner = { schedulePost: jest.fn() };
  const anthropic = { isEnabled: () => true, complete: jest.fn() };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'a-1' }) };
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any, anthropic as any, credits as any, mediaGen as any,
  );
  return { svc, prisma, scheduledJobs, contentAi, mediaGen };
}

const plan = (svc: any, ws = WS) => (svc as any).planTick('c-1', ws);
const gen = (svc: any, ws = WS) => (svc as any).generateItem('i-1', ws);

describe('planTick — planning modes + cadence + stop', () => {
  it('AI_FULL: derives a topic, creates an item, fans out generation, reschedules', async () => {
    const { svc, prisma, scheduledJobs, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ planningMode: 'AI_FULL' }));
    prisma.socialCampaignItem.create.mockResolvedValueOnce({ id: 'i-1' });
    const res = await plan(svc);
    expect(contentAi.compose).toHaveBeenCalledTimes(1);
    expect(prisma.socialCampaignItem.create).toHaveBeenCalled();
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, payload: { itemId: 'i-1', workspaceId: WS },
    }));
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { campaignId: 'c-1', workspaceId: WS } }) });
  });

  it('AI_PROPOSE: creates a PLANNED item but does NOT fan out generation', async () => {
    const { svc, prisma, scheduledJobs, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ planningMode: 'AI_PROPOSE' }));
    prisma.socialCampaignItem.create.mockResolvedValueOnce({ id: 'i-1' });
    await plan(svc);
    expect(contentAi.compose).toHaveBeenCalledTimes(1);
    expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND }),
    );
  });

  it('USER_TOPICS: uses brief.topics (no AI topic call) and fans out generation', async () => {
    const { svc, prisma, scheduledJobs, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ planningMode: 'USER_TOPICS' }));
    prisma.socialCampaignItem.count.mockResolvedValueOnce(0); // 0 items so far → topics[0]
    prisma.socialCampaignItem.create.mockResolvedValueOnce({ id: 'i-1' });
    await plan(svc);
    expect(contentAi.compose).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ topic: 'User topic A' }) }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND }),
    );
  });

  it('stop-on-pause: a non-ACTIVE campaign creates nothing and does not reschedule', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'PAUSED' }));
    const res = await plan(svc);
    expect(res).toBeUndefined();
    expect(prisma.socialCampaignItem.create).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('completes when the next slot is past endDate', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(
      makeCampaign({ endDate: new Date('2026-07-01T00:00:00Z') }),
    );
    await plan(svc);
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'COMPLETED' } });
  });
});

describe('generateItem — automation-mode transitions', () => {
  function primeItem(prisma: any, automationMode: string) {
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce({
      id: 'i-1', socialCampaignId: 'c-1', workspaceId: WS, scheduledFor: new Date('2026-07-08T09:00:00Z'),
      status: 'PLANNED', topic: 'Topic', campaign: makeCampaign({ automationMode }),
    });
  }

  it('composes copy, requests media, creates a draft post linked to the campaign', async () => {
    const { svc, prisma, contentAi, mediaGen } = build();
    primeItem(prisma, 'APPROVAL');
    await gen(svc);
    expect(contentAi.compose).toHaveBeenCalledWith(WS, expect.objectContaining({ kind: 'social' }));
    expect(mediaGen.requestGeneration).toHaveBeenCalledWith(
      WS, expect.objectContaining({ type: 'IMAGE', socialCampaignId: 'c-1', campaignItemId: 'i-1', createdById: 'u-1' }),
    );
    expect(prisma.socialPost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ socialCampaignId: 'c-1', campaignItemId: 'i-1', status: 'DRAFT' }) }),
    );
  });

  it('APPROVAL → item NEEDS_APPROVAL, no confirm job', async () => {
    const { svc, prisma, scheduledJobs } = build();
    primeItem(prisma, 'APPROVAL');
    await gen(svc);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_APPROVAL', socialPostId: 'post-1' }) }),
    );
    expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND }),
    );
  });

  it('SEMI_AUTO → item SCHEDULED + confirm gate enqueued at scheduledFor', async () => {
    const { svc, prisma, scheduledJobs } = build();
    primeItem(prisma, 'SEMI_AUTO');
    await gen(svc);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED' }) }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, runAt: new Date('2026-07-08T09:00:00Z'),
      payload: { itemId: 'i-1', workspaceId: WS },
    }));
  });

  it('FULL_AUTO → item SCHEDULED + confirm gate enqueued', async () => {
    const { svc, prisma, scheduledJobs } = build();
    primeItem(prisma, 'FULL_AUTO');
    await gen(svc);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED' }) }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND }),
    );
  });
});
