import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SlotEditorService } from './slot-editor.service';
import { CONTENT_SLOT_PLAN_KIND, CONTENT_SLOT_PRODUCE_KIND, slotPlanDedup, slotProduceDedup } from './programme-planner.service';

const WS = 'ws-1';
const PROG = 'prog-1';
const NOW = new Date('2026-09-16T12:00:00Z');
const H = 60 * 60 * 1000;
const D = 24 * H;
const at = (iso: string) => new Date(iso);
const ACTOR = 'u-owner';

function programme(over: Record<string, unknown> = {}) {
  return { id: PROG, workspaceId: WS, status: 'ACTIVE', socialCampaignId: 'camp-1', editWindowHours: 2, lookaheadDays: 14, planLeadHours: 36, produceLeadHours: 12, ...over } as any;
}
function slot(over: Record<string, unknown> = {}) {
  return {
    id: 'slot-1', workspaceId: WS, programmeId: PROG, scheduledFor: at('2026-09-18T18:00:00Z'), status: 'PLANNED',
    contentTypeId: 'id-how-to', contentTypeKey: 'how-to', selectionReason: 'seed', trendSignalId: null, trendTitle: null,
    idea: 'old idea', conceptId: null, campaignItemId: null, socialPostId: null, quotedCredits: null,
    editableUntil: at('2026-09-18T16:00:00Z'), publishedAt: null, measuredAt: null, reward: null, rewardBreakdown: null, error: null, ...over,
  } as any;
}

function harness(over: { slot?: unknown; item?: unknown } = {}) {
  const current = over.slot === undefined ? slot() : over.slot;
  const prisma: any = {
    contentSlot: {
      findFirst: jest.fn().mockResolvedValue(current),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...(current as object), ...data })),
    },
    contentType: { findFirst: jest.fn().mockResolvedValue({ id: 'id-pov', key: 'pov-ugc', active: true }) },
    contentConcept: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    socialCampaignItem: { findFirst: jest.fn().mockResolvedValue(over.item === undefined ? { id: 'item-1', status: 'SCHEDULED', scheduledFor: at('2026-09-18T18:00:00Z'), error: null, socialPostId: null } : over.item) },
    socialPost: { findFirst: jest.fn().mockResolvedValue(null) },
    socialPostTarget: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1'), cancel: jest.fn().mockResolvedValue(true) };
  const programmes = { getOrThrow: jest.fn().mockResolvedValue(programme()), logEvent: jest.fn().mockResolvedValue(undefined) };
  const socialCampaigns = { rejectItem: jest.fn().mockResolvedValue({ id: 'item-1', status: 'SKIPPED' }), regenerateItem: jest.fn().mockResolvedValue({ id: 'item-1' }) };
  const arming = { armApproved: jest.fn().mockResolvedValue({ id: 'item-1', status: 'SCHEDULED' }) };
  const svc = new SlotEditorService(prisma, scheduledJobs as any, programmes as any, socialCampaigns as any, arming as any);
  return { svc, prisma, scheduledJobs, programmes, socialCampaigns, arming };
}
const update = (prisma: any) => prisma.contentSlot.update.mock.calls[0]?.[0];
const jobs = (scheduledJobs: any) => scheduledJobs.schedule.mock.calls.map((c: any[]) => c[0]);
const event = (programmes: any, kind: string) => programmes.logEvent.mock.calls.map((c: any[]) => ({ kind: c[2], message: c[3], data: c[4] })).find((e: any) => e.kind === kind);

describe('SlotEditorService.updateSlot — the window', () => {
  it('refuses a slot that is past its edit window, naming when it froze', async () => {
    const { svc, prisma } = harness({ slot: slot({ editableUntil: at('2026-09-16T11:00:00Z') }) });
    await expect(svc.updateSlot(WS, 'slot-1', { idea: 'x' }, ACTOR, NOW)).rejects.toThrow(/froze at 2026-09-16T11:00:00.000Z/);
    expect(prisma.contentSlot.update).not.toHaveBeenCalled();
  });

  it('refuses a slot whose status is not editable, by name', async () => {
    const { svc } = harness({ slot: slot({ status: 'PRODUCING' }) });
    await expect(svc.updateSlot(WS, 'slot-1', { idea: 'x' }, ACTOR, NOW)).rejects.toThrow(/A PRODUCING slot cannot be edited/);
  });

  it('is NotFound for a slot of another workspace, and the lookup is workspace-scoped', async () => {
    const { svc, prisma } = harness({ slot: null });
    await expect(svc.updateSlot(WS, 'foreign', { idea: 'x' }, ACTOR, NOW)).rejects.toThrow(NotFoundException);
    expect(prisma.contentSlot.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', workspaceId: WS } });
  });

  it('validates the patch: an unknown/inactive type, an empty or oversized idea, a past or too-distant time', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findFirst.mockResolvedValueOnce(null);
    await expect(svc.updateSlot(WS, 'slot-1', { contentTypeKey: 'nope' }, ACTOR, NOW)).rejects.toThrow(/not an active content type/);
    expect(prisma.contentType.findFirst).toHaveBeenCalledWith({ where: { workspaceId: WS, key: 'nope', active: true } });
    await expect(svc.updateSlot(WS, 'slot-1', { idea: '   ' }, ACTOR, NOW)).rejects.toThrow(BadRequestException);
    await expect(svc.updateSlot(WS, 'slot-1', { idea: 'x'.repeat(4001) }, ACTOR, NOW)).rejects.toThrow(/1 to 4000/);
    await expect(svc.updateSlot(WS, 'slot-1', { scheduledFor: new Date(NOW.getTime() - 1) }, ACTOR, NOW)).rejects.toThrow(/in the future/);
    await expect(svc.updateSlot(WS, 'slot-1', { scheduledFor: new Date(NOW.getTime() + 16 * D) }, ACTOR, NOW)).rejects.toThrow(/within the next 15 days/);
    expect(prisma.contentSlot.update).not.toHaveBeenCalled();
  });
});

describe('SlotEditorService.updateSlot — PLANNED', () => {
  it('writes the new type as an owner override, the idea, and logs who changed what', async () => {
    const { svc, prisma, programmes, scheduledJobs } = harness();
    const out = await svc.updateSlot(WS, 'slot-1', { contentTypeKey: 'pov-ugc', idea: '  new idea  ' }, ACTOR, NOW);
    expect(update(prisma)).toEqual({
      where: { id: 'slot-1' },
      data: { contentTypeId: 'id-pov', contentTypeKey: 'pov-ugc', selectionReason: `owner override by ${ACTOR}`, idea: 'new idea' },
    });
    expect(out.contentTypeKey).toBe('pov-ugc');
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(event(programmes, 'SLOT_EDITED').data).toMatchObject({ slotId: 'slot-1', actorId: ACTOR, changed: ['contentTypeKey', 'idea'] });
  });

  it('a move recomputes editableUntil and re-arms both slot jobs at the new lead times', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    const to = at('2026-09-22T18:00:00Z');
    await svc.updateSlot(WS, 'slot-1', { scheduledFor: to }, ACTOR, NOW);
    expect(update(prisma).data).toEqual({ scheduledFor: to, editableUntil: at('2026-09-22T16:00:00Z') });
    expect(jobs(scheduledJobs)).toEqual([
      expect.objectContaining({ kind: CONTENT_SLOT_PLAN_KIND, runAt: at('2026-09-21T06:00:00Z'), dedupKey: slotPlanDedup('slot-1'), workspaceId: WS }),
      expect.objectContaining({ kind: CONTENT_SLOT_PRODUCE_KIND, runAt: at('2026-09-22T06:00:00Z'), dedupKey: slotProduceDedup('slot-1') }),
    ]);
  });

  it('returns the slot untouched when nothing actually changes', async () => {
    const { svc, prisma, programmes } = harness();
    await svc.updateSlot(WS, 'slot-1', { idea: 'old idea', scheduledFor: at('2026-09-18T18:00:00Z') }, ACTOR, NOW);
    expect(prisma.contentSlot.update).not.toHaveBeenCalled();
    expect(programmes.logEvent).not.toHaveBeenCalled();
  });

  it('turns a time collision into a BadRequest', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.update.mockRejectedValue({ code: 'P2002' });
    await expect(svc.updateSlot(WS, 'slot-1', { scheduledFor: at('2026-09-22T18:00:00Z') }, ACTOR, NOW)).rejects.toThrow(/already at that time/);
  });
});

describe('SlotEditorService.updateSlot — IDEATED', () => {
  const ideated = () => slot({ status: 'IDEATED', conceptId: 'c-1', quotedCredits: 45 });

  it('a type or idea change gives the concept back, resets to PLANNED and pulls the plan job to now', async () => {
    const { svc, prisma, scheduledJobs, programmes } = harness({ slot: ideated() });
    await svc.updateSlot(WS, 'slot-1', { contentTypeKey: 'pov-ugc' }, ACTOR, NOW);
    expect(prisma.contentConcept.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-1', workspaceId: WS, status: 'PROPOSED' },
      data: { status: 'DISCARDED', reviewedAt: NOW, reviewedById: `programme:${PROG}`, reviewNote: 'owner edited the slot (contentTypeKey)' },
    });
    expect(update(prisma).data).toMatchObject({ contentTypeKey: 'pov-ugc', status: 'PLANNED', conceptId: null, quotedCredits: null, error: null });
    expect(scheduledJobs.cancel).toHaveBeenCalledWith(CONTENT_SLOT_PLAN_KIND, slotPlanDedup('slot-1'));
    const planJobs = jobs(scheduledJobs).filter((j: any) => j.kind === CONTENT_SLOT_PLAN_KIND);
    expect(planJobs[planJobs.length - 1]).toMatchObject({ runAt: NOW, dedupKey: slotPlanDedup('slot-1'), payload: { workspaceId: WS, slotId: 'slot-1', programmeId: PROG } });
    expect(event(programmes, 'SLOT_EDITED').data).toMatchObject({ from: 'IDEATED', to: 'PLANNED', changed: ['contentTypeKey'] });
  });

  it('a pure move keeps the concept and only re-arms the jobs', async () => {
    const { svc, prisma, scheduledJobs } = harness({ slot: ideated() });
    await svc.updateSlot(WS, 'slot-1', { scheduledFor: at('2026-09-22T18:00:00Z') }, ACTOR, NOW);
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
    expect(update(prisma).data.status).toBeUndefined();
    expect(scheduledJobs.cancel).not.toHaveBeenCalled();
    expect(jobs(scheduledJobs)).toHaveLength(2);
  });
});

describe('SlotEditorService.updateSlot — READY', () => {
  const ready = () => slot({ status: 'READY', conceptId: 'c-1', campaignItemId: 'item-1', quotedCredits: 45 });

  it('refuses a type or idea change: the clips are bought', async () => {
    const { svc, prisma } = harness({ slot: ready() });
    await expect(svc.updateSlot(WS, 'slot-1', { idea: 'different' }, ACTOR, NOW)).rejects.toThrow(/already produced; regenerate it or skip it/);
    expect(prisma.contentSlot.update).not.toHaveBeenCalled();
  });

  it('a move re-arms the campaign item at the new time through the arming service (same dedup key, one step)', async () => {
    const { svc, prisma, arming, scheduledJobs } = harness({ slot: ready() });
    const to = at('2026-09-22T18:00:00Z');
    await svc.updateSlot(WS, 'slot-1', { scheduledFor: to }, ACTOR, NOW);
    expect(update(prisma).data).toEqual({ scheduledFor: to, editableUntil: at('2026-09-22T16:00:00Z') });
    expect(prisma.socialCampaignItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item-1', workspaceId: WS } }));
    expect(arming.armApproved).toHaveBeenCalledWith({ workspaceId: WS, itemId: 'item-1', scheduledFor: to, data: { scheduledFor: to } });
    // The slot's own jobs have run; only the publish gate moves.
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('puts the time back and refuses when the item is already past the gate', async () => {
    const { svc, prisma, arming } = harness({ slot: ready(), item: { id: 'item-1', status: 'PUBLISHED' } });
    await expect(svc.updateSlot(WS, 'slot-1', { scheduledFor: at('2026-09-22T18:00:00Z') }, ACTOR, NOW)).rejects.toThrow(/PUBLISHED and can no longer be moved/);
    expect(arming.armApproved).not.toHaveBeenCalled();
    expect(prisma.contentSlot.update).toHaveBeenLastCalledWith({
      where: { id: 'slot-1' }, data: { scheduledFor: at('2026-09-18T18:00:00Z'), editableUntil: at('2026-09-18T16:00:00Z') },
    });
  });
});

describe('SlotEditorService.skipSlot', () => {
  it('READY: rejects the item first, discards the concept, cancels both jobs and marks the slot SKIPPED by the actor', async () => {
    const { svc, prisma, scheduledJobs, socialCampaigns, programmes } = harness({ slot: slot({ status: 'READY', conceptId: 'c-1', campaignItemId: 'item-1' }) });
    const out = await svc.skipSlot(WS, 'slot-1', ACTOR, NOW);
    expect(socialCampaigns.rejectItem).toHaveBeenCalledWith(WS, 'item-1');
    expect(prisma.contentConcept.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c-1', workspaceId: WS, status: 'PROPOSED' } }));
    expect(scheduledJobs.cancel.mock.calls).toEqual([[CONTENT_SLOT_PLAN_KIND, slotPlanDedup('slot-1')], [CONTENT_SLOT_PRODUCE_KIND, slotProduceDedup('slot-1')]]);
    expect(update(prisma)).toEqual({ where: { id: 'slot-1' }, data: { status: 'SKIPPED', error: `skipped by ${ACTOR}` } });
    expect(out.status).toBe('SKIPPED');
    expect(event(programmes, 'SLOT_SKIPPED').data).toMatchObject({ actorId: ACTOR, from: 'READY', campaignItemId: 'item-1' });
  });

  it('PLANNED: no item, no concept — just the jobs and the row', async () => {
    const { svc, prisma, socialCampaigns } = harness();
    await svc.skipSlot(WS, 'slot-1', ACTOR, NOW);
    expect(socialCampaigns.rejectItem).not.toHaveBeenCalled();
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
    expect(update(prisma).data.status).toBe('SKIPPED');
  });

  it('a refused item rejection leaves the slot as it was', async () => {
    const { svc, prisma, socialCampaigns } = harness({ slot: slot({ status: 'READY', campaignItemId: 'item-1' }) });
    socialCampaigns.rejectItem.mockRejectedValue(new BadRequestException('Cannot reject an item in status PUBLISHED'));
    await expect(svc.skipSlot(WS, 'slot-1', ACTOR, NOW)).rejects.toThrow(/Cannot reject/);
    expect(prisma.contentSlot.update).not.toHaveBeenCalled();
  });

  it('refuses PRODUCING / PUBLISHED / SKIPPED slots', async () => {
    for (const status of ['PRODUCING', 'PUBLISHED', 'SKIPPED']) {
      const { svc } = harness({ slot: slot({ status }) });
      await expect(svc.skipSlot(WS, 'slot-1', ACTOR, NOW)).rejects.toThrow(new RegExp(`A ${status} slot cannot be skipped`));
    }
  });
});

describe('SlotEditorService.regenerateSlot', () => {
  it('READY with an armed (SCHEDULED) item: rejects then regenerates through the campaign\'s doors, slot → PRODUCING', async () => {
    const { svc, prisma, socialCampaigns, programmes } = harness({ slot: slot({ status: 'READY', campaignItemId: 'item-1' }) });
    const out = await svc.regenerateSlot(WS, 'slot-1', ACTOR);
    expect(socialCampaigns.rejectItem).toHaveBeenCalledWith(WS, 'item-1');
    expect(socialCampaigns.regenerateItem).toHaveBeenCalledWith(WS, 'item-1');
    expect(socialCampaigns.rejectItem.mock.invocationCallOrder[0]).toBeLessThan(socialCampaigns.regenerateItem.mock.invocationCallOrder[0]);
    expect(update(prisma)).toEqual({ where: { id: 'slot-1' }, data: { status: 'PRODUCING', error: null } });
    expect(out.status).toBe('PRODUCING');
    expect(event(programmes, 'SLOT_REGENERATED').data).toMatchObject({ actorId: ACTOR, from: 'READY', itemStatus: 'SCHEDULED' });
  });

  it('FAILED with a FAILED item: regenerates directly (the cursor of bought beats survives there)', async () => {
    const { svc, socialCampaigns } = harness({ slot: slot({ status: 'FAILED', campaignItemId: 'item-1' }), item: { id: 'item-1', status: 'FAILED' } });
    await svc.regenerateSlot(WS, 'slot-1', ACTOR);
    expect(socialCampaigns.rejectItem).not.toHaveBeenCalled();
    expect(socialCampaigns.regenerateItem).toHaveBeenCalledWith(WS, 'item-1');
  });

  it('refuses a slot that never reached production, and an item that cannot be regenerated', async () => {
    const planned = harness();
    await expect(planned.svc.regenerateSlot(WS, 'slot-1', ACTOR)).rejects.toThrow(/A PLANNED slot without a campaign item cannot be regenerated/);
    const failedNoItem = harness({ slot: slot({ status: 'FAILED' }) });
    await expect(failedNoItem.svc.regenerateSlot(WS, 'slot-1', ACTOR)).rejects.toThrow(BadRequestException);
    const live = harness({ slot: slot({ status: 'READY', campaignItemId: 'item-1' }), item: { id: 'item-1', status: 'PUBLISHED' } });
    await expect(live.svc.regenerateSlot(WS, 'slot-1', ACTOR)).rejects.toThrow(/PUBLISHED and cannot be regenerated/);
    expect(live.socialCampaigns.regenerateItem).not.toHaveBeenCalled();
  });
});

describe('SlotEditorService.slotMetrics', () => {
  it('assembles the slot, its concept, item, post and the latest metric row per target — every read workspace-scoped', async () => {
    const measured = slot({ status: 'MEASURED', conceptId: 'c-1', campaignItemId: 'item-1', socialPostId: 'post-1', reward: 0.62, rewardBreakdown: { INSTAGRAM: { reward: 0.62 } } });
    const { svc, prisma } = harness({ slot: measured, item: { id: 'item-1', status: 'PUBLISHED', scheduledFor: at('2026-09-18T18:00:00Z'), error: null, socialPostId: 'post-1' } });
    prisma.contentConcept.findFirst.mockResolvedValue({ id: 'c-1', title: 'T', hook: 'H', angle: 'story', contentTypeKey: 'how-to', shotPlan: { durationSec: 15, shots: [{}, {}, {}] } });
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'post-1', publishedAt: at('2026-09-18T18:01:00Z'), content: 'caption' });
    prisma.socialPostTarget.findMany.mockResolvedValue([
      { network: 'INSTAGRAM', status: 'PUBLISHED', metrics: [{ impressions: 1000, reach: 800, engagements: 90, likes: 70, comments: 10, shares: 5, saves: 5, videoViews: 600, leads: 1, date: at('2026-09-20T00:00:00Z') }] },
      { network: 'TIKTOK', status: 'FAILED', metrics: [] },
    ]);

    const view = await svc.slotMetrics(WS, 'slot-1');

    expect(view).toEqual({
      slot: measured,
      concept: { id: 'c-1', title: 'T', hook: 'H', angle: 'story', contentTypeKey: 'how-to', beats: 3, durationSec: 15 },
      item: { id: 'item-1', status: 'PUBLISHED', scheduledFor: at('2026-09-18T18:00:00Z'), error: null },
      post: { id: 'post-1', publishedAt: at('2026-09-18T18:01:00Z'), content: 'caption' },
      targets: [
        { network: 'INSTAGRAM', status: 'PUBLISHED', latest: { impressions: 1000, reach: 800, engagements: 90, likes: 70, comments: 10, shares: 5, saves: 5, videoViews: 600, leads: 1, date: at('2026-09-20T00:00:00Z') } },
        { network: 'TIKTOK', status: 'FAILED', latest: null },
      ],
      reward: 0.62,
      rewardBreakdown: { INSTAGRAM: { reward: 0.62 } },
    });
    expect(prisma.contentConcept.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c-1', workspaceId: WS } }));
    expect(prisma.socialCampaignItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item-1', workspaceId: WS } }));
    expect(prisma.socialPost.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'post-1', workspaceId: WS } }));
    expect(prisma.socialPostTarget.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS, postId: 'post-1' },
      select: expect.objectContaining({ metrics: { orderBy: { date: 'desc' }, take: 1 } }),
    }));
  });

  it('a PLANNED slot is the slot alone, with empty relations', async () => {
    const { svc, prisma } = harness();
    const view = await svc.slotMetrics(WS, 'slot-1');
    expect(view).toMatchObject({ concept: null, item: null, post: null, targets: [], reward: null, rewardBreakdown: null });
    expect(prisma.contentConcept.findFirst).not.toHaveBeenCalled();
    expect(prisma.socialPostTarget.findMany).not.toHaveBeenCalled();
  });
});
