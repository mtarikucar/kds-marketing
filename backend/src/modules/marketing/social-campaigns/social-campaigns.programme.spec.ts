import { BadRequestException } from '@nestjs/common';
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

function build(over: { programme?: unknown } = {}) {
  const prisma: any = {
    socialCampaign: { findFirst: jest.fn(), findUnique: jest.fn().mockResolvedValue({ stats: null }), update: jest.fn() },
    contentProgramme: {
      findFirst: jest.fn().mockResolvedValue(over.programme === undefined ? { status: 'PAUSED', killSwitch: false } : over.programme),
    },
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

/**
 * The lane's own resume/activate doors are closed to anyone but the
 * programme. On pause and on kill the programme leaves every READY slot's
 * item SCHEDULED behind the paused gate; resuming the campaign from the
 * campaigns list (or an agent's set_campaign_status) would release them all
 * at once, and after a kill there is no programme left to have decided that.
 */
describe('resume / activate — a programme-owned campaign is moved by the programme, not by hand', () => {
  it('resume refuses a lane whose programme is PAUSED, naming the right door, and writes nothing', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1', status: 'PAUSED' }));
    await expect(svc.resume(WS, 'c-1')).rejects.toThrow("This campaign is a content programme's lane; resume the programme instead.");
    expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prog-1', workspaceId: WS } }),
    );
    expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('activate refuses the same lane the same way', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1', status: 'PAUSED' }));
    await expect(svc.activate(WS, 'c-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
  });

  it('says the programme was killed when it was — a killed lane never comes back through here', async () => {
    for (const programme of [{ status: 'KILLED', killSwitch: true }, { status: 'ACTIVE', killSwitch: true }, null]) {
      const { svc, prisma } = build({ programme });
      prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1', status: 'PAUSED' }));
      await expect(svc.resume(WS, 'c-1')).rejects.toThrow(/the programme was killed/);
      expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
    }
  });

  it('the programme itself passes with byProgramme, and the plan tick is enqueued as for any campaign', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst
      .mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1', status: 'PAUSED' }))
      .mockResolvedValue(makeCampaign({ programmeId: 'prog-1', status: 'ACTIVE' }));
    await svc.resume(WS, 'c-1', { byProgramme: true });
    expect(prisma.contentProgramme.findFirst).not.toHaveBeenCalled();
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'ACTIVE' } });
    expect(scheduledJobs.schedule).toHaveBeenCalled();

    const draft = build();
    draft.prisma.socialCampaign.findFirst
      .mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1', status: 'DRAFT' }))
      .mockResolvedValue(makeCampaign({ programmeId: 'prog-1', status: 'ACTIVE' }));
    await draft.svc.activate(WS, 'c-1', { byProgramme: true });
    expect(draft.prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'ACTIVE' } });
  });

  it('a campaign WITHOUT a programme resumes exactly as before, asking no programme', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst
      .mockResolvedValueOnce(makeCampaign({ status: 'PAUSED' }))
      .mockResolvedValue(makeCampaign({ status: 'ACTIVE' }));
    await svc.resume(WS, 'c-1');
    expect(prisma.contentProgramme.findFirst).not.toHaveBeenCalled();
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'ACTIVE' } });
  });

  it('pause stays open on the lane: a hand-paused lane is a safe state the programme holds for', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst
      .mockResolvedValueOnce(makeCampaign({ programmeId: 'prog-1', status: 'ACTIVE' }))
      .mockResolvedValue(makeCampaign({ programmeId: 'prog-1', status: 'PAUSED' }));
    await svc.pause(WS, 'c-1');
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'PAUSED' } });
    expect(scheduledJobs.cancel).toHaveBeenCalled();
  });
});
