import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    socialCampaignItem: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
    // PUBLISHED is claimed atomically (SCHEDULED → PUBLISHED) before publishing so
    // a mid-publish retry can't re-charge brand-safety or re-send.
    expect(prisma.socialCampaignItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'i-1', status: { in: ['SCHEDULED'] } }),
        data: { status: 'PUBLISHED' },
      }),
    );
  });

  it('idempotent: a lost publish claim (count 0) does not publish or re-charge', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.updateMany.mockResolvedValueOnce({ count: 0 }); // already claimed by a prior run
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(anthropic.complete).not.toHaveBeenCalled(); // brand-safety not re-charged
  });

  it('waits (reschedules) when the generated media is not yet READY instead of publishing text-only', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ scheduledFor: new Date(), generatedAssetIds: ['asset-1'] }),
    );
    prisma.generatedAsset.findMany.mockResolvedValueOnce([{ status: 'GENERATING' }]);
    const res = await confirm(svc);
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { itemId: 'i-1', workspaceId: WS } }) });
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.updateMany).not.toHaveBeenCalled();
  });

  it('multi-media: waits when ANY asset is still generating even if another is READY (no orphaned media)', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ scheduledFor: new Date(), generatedAssetIds: ['img-1', 'vid-1'] }),
    );
    // image ready, video still generating → must WAIT, not publish image-only.
    prisma.generatedAsset.findMany.mockResolvedValueOnce([{ status: 'READY' }, { status: 'GENERATING' }]);
    const res = await confirm(svc);
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { itemId: 'i-1', workspaceId: WS } }) });
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.updateMany).not.toHaveBeenCalled(); // not yet claimed/published
  });

  it('SEMI_AUTO auto-publishes a NEEDS_APPROVAL item the user did not reject', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ status: 'NEEDS_APPROVAL', campaign: makeCampaign({ automationMode: 'SEMI_AUTO' }) }),
    );
    await confirm(svc);
    expect(prisma.socialCampaignItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'i-1', status: { in: ['SCHEDULED', 'NEEDS_APPROVAL'] } }),
        data: { status: 'PUBLISHED' },
      }),
    );
    expect(planner.schedulePost).toHaveBeenCalled();
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

  it('regenerateItem rejects a PUBLISHED item (no re-charge / re-publish)', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'PUBLISHED' }));
    await expect(svc.regenerateItem(WS, 'i-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('rejectItem rejects a PUBLISHED (already-live) item', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'PUBLISHED' }));
    await expect(svc.rejectItem(WS, 'i-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaignItem.update).not.toHaveBeenCalled();
  });

  it('approveItem throws NotFound for an unknown item', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(null);
    await expect(svc.approveItem(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
