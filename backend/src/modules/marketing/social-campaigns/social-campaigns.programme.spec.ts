import { SocialCampaignsService, SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND } from './social-campaigns.service';
import { BrandSafetyService } from '../ai/brand-safety.service';
import { CampaignItemArmingService } from './campaign-item-arming.service';

const WS = 'ws-1';

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Programme lane', goal: 'AWARENESS', theme: 'kinetic sculptures',
    brief: { theme: 'kinetic sculptures', programme: true }, status: 'ACTIVE',
    automationMode: 'FULL_AUTO', planningMode: 'AI_FULL',
    cadence: { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '18:00', timezone: 'Europe/Istanbul' },
    startDate: new Date('2026-09-01T00:00:00Z'), endDate: null,
    targetAccountIds: ['acc-1'], mediaKinds: ['VIDEO'], dailyPublishCap: 1,
    defaultImageModel: null, defaultVideoModel: null, createdById: 'u-1', stats: null,
    programmeId: null,
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
  const arming = new CampaignItemArmingService(prisma, scheduledJobs as any);
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any,
    new BrandSafetyService(anthropic as any, credits as any),
    mediaGen as any,
    arming,
    undefined as any,
    undefined as any,
  );
  return { svc, prisma, scheduledJobs, contentAi };
}

const plan = (svc: any) => (svc as any).planTick('c-1', WS);

describe('planTick — a programme-owned campaign is a publishing lane, not a planner', () => {
  /**
   * The programme fills the calendar with typed, learned slots; the campaign it
   * publishes through must not ALSO plan its own generic items, or every slot
   * the programme chose would sit next to a stock topic the campaign invented
   * at the same cadence — and both would spend.
   */
  it('creates nothing, asks the model nothing and does not reschedule when programmeId is set', async () => {
    const { svc, prisma, scheduledJobs, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1' }));

    const res = await plan(svc);

    expect(res).toBeUndefined();
    expect(contentAi.compose).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.create).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND }),
    );
    // Not COMPLETED either: the lane stays ACTIVE for the programme to publish through.
    expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
  });

  it('still refuses a non-ACTIVE campaign first — a paused lane plans nothing either way', async () => {
    const { svc, prisma, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1', status: 'PAUSED' }));
    await plan(svc);
    expect(contentAi.compose).not.toHaveBeenCalled();
  });

  it('a campaign WITHOUT a programme plans exactly as before', async () => {
    const { svc, prisma, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign());
    prisma.socialCampaignItem.create.mockResolvedValueOnce({ id: 'i-1' });
    const res = await plan(svc);
    expect(contentAi.compose).toHaveBeenCalledTimes(1);
    expect(prisma.socialCampaignItem.create).toHaveBeenCalled();
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { campaignId: 'c-1', workspaceId: WS } }) });
  });
});
