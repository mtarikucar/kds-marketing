import { NotFoundException } from '@nestjs/common';
import { SocialCampaignsService, SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, generateDedup } from './social-campaigns.service';

const WS = 'ws-1';
const SLOT = new Date('2026-07-08T09:00:00Z');

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Launch', status: 'ACTIVE', automationMode: 'FULL_AUTO',
    targetAccountIds: ['acc-1'], dailyPublishCap: 2, ...over,
  };
}
function makeItem(over: Partial<any> = {}) {
  return { id: 'i-1', socialCampaignId: 'c-1', workspaceId: WS, scheduledFor: SLOT, status: 'SCHEDULED', socialPostId: 'post-1', campaign: makeCampaign(), ...over };
}

function build() {
  const prisma: any = {
    socialCampaign: { findUnique: jest.fn().mockResolvedValue({ stats: null }), update: jest.fn() },
    socialCampaignItem: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0), update: jest.fn() },
    socialPost: { findFirst: jest.fn().mockResolvedValue({ id: 'post-1', content: 'Nice copy' }), update: jest.fn() },
    generatedAsset: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const scheduledJobs = { schedule: jest.fn(), cancel: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn() };
  const planner = { schedulePost: jest.fn().mockResolvedValue({}) };
  const anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn().mockResolvedValue({ text: 'SAFE' }) };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn() };
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any, anthropic as any, credits as any, mediaGen as any,
  );
  return { svc, prisma, scheduledJobs, planner, anthropic, credits };
}
const confirm = (svc: any) => (svc as any).confirmItem('i-1', WS);

describe('confirmItem — gate, cap rollover, brand-safety', () => {
  it('FULL_AUTO under cap + SAFE copy → publishes via the planner, item PUBLISHED', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.count.mockResolvedValueOnce(0);
    await confirm(svc);
    expect(planner.schedulePost).toHaveBeenCalledWith(WS, 'post-1', expect.any(Date), ['acc-1']);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PUBLISHED' }) }),
    );
  });

  it('over dailyPublishCap → reschedules to the next day, no publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.count.mockResolvedValueOnce(2); // cap = 2 already published today
    const res = await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    const next = new Date('2026-07-09T09:00:00Z');
    expect(res).toEqual({ reschedule: { runAt: next, payload: { itemId: 'i-1', workspaceId: WS } } });
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scheduledFor: next }) }),
    );
  });

  it('brand-safety BLOCK → item SKIPPED, no publish', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    anthropic.complete.mockResolvedValueOnce({ text: 'BLOCK' });
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED', error: expect.stringContaining('brand-safety') }) }),
    );
  });

  it('a user veto (item already SKIPPED) cancels the pending publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'SKIPPED' }));
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
  });

  it('stop-on-pause: paused campaign → no publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ campaign: makeCampaign({ status: 'PAUSED' }) }));
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
  });

  it('skips the Claude check (treats as safe) when AI is disabled', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    anthropic.isEnabled.mockReturnValue(false);
    await confirm(svc);
    expect(anthropic.complete).not.toHaveBeenCalled();
    expect(planner.schedulePost).toHaveBeenCalled();
  });
});

describe('item approve / reject / regenerate', () => {
  it('approveItem: NEEDS_APPROVAL → SCHEDULED and arms the confirm gate', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'NEEDS_APPROVAL' }));
    await svc.approveItem(WS, 'i-1');
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SCHEDULED' } }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, payload: { itemId: 'i-1', workspaceId: WS } }),
    );
  });

  it('rejectItem → SKIPPED', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'NEEDS_APPROVAL' }));
    await svc.rejectItem(WS, 'i-1');
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SKIPPED' } }),
    );
  });

  it('regenerateItem re-enqueues generation', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'FAILED' }));
    await svc.regenerateItem(WS, 'i-1');
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, dedupKey: generateDedup('i-1'),
    }));
  });

  it('approveItem throws NotFound for an unknown item', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(null);
    await expect(svc.approveItem(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
