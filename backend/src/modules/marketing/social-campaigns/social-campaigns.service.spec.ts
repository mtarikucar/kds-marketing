import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  SocialCampaignsService,
  SOCIAL_CAMPAIGN_PLAN_KIND,
  SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND,
  planDedup,
} from './social-campaigns.service';

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
    socialPost: { create: jest.fn(), findFirst: jest.fn() },
    brandKit: { findUnique: jest.fn() },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1'), cancel: jest.fn().mockResolvedValue(true) };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn() };
  const planner = { schedulePost: jest.fn() };
  const anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn() };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn() };
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any, anthropic as any, credits as any, mediaGen as any,
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
