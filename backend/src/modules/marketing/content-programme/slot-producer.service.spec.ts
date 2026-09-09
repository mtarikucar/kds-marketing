import {
  CAP_RETRY_MS,
  MISSED_WHILE_PAUSED,
  NO_QUOTE_ERROR,
  PAUSE_RETRY_MS,
  SLOT_CONCEPT_COUNT,
  SlotProducerService,
  estimateSlotCredits,
  hookSimilarity,
  pickDistinctConcept,
} from './slot-producer.service';
import { CONTENT_SLOT_PLAN_KIND, CONTENT_SLOT_PRODUCE_KIND, slotProduceDedup } from './programme-planner.service';
import { creditCost } from '../ai/ai-credit-costs';
import { DEFAULT_KEYFRAME_MODEL, DEFAULT_VIDEO_MODEL, animateModelFor, estimateMediaCredits } from '../ai/media/media-models.config';

const WS = 'ws-1';
const PROG = 'prog-1';
const CAMP = 'camp-1';
/** Wednesday 12:00 UTC. */
const NOW = new Date('2026-09-16T12:00:00Z');
const H = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const BATCH_COST = creditCost('content.concepts');
/** The frames the fixture concepts carry in their quote. */
const FRAMES = 6;
const PREMIUM = 'bytedance/seedance-2.5/text-to-video';

function programme(over: Record<string, unknown> = {}) {
  return {
    id: PROG, workspaceId: WS, status: 'ACTIVE', killSwitch: false, socialCampaignId: CAMP, brief: 'Figurunica figürleri',
    personaId: 'persona-1', createdById: 'u-1', weeklyCreditCap: 600, planLeadHours: 36, produceLeadHours: 12, ...over,
  } as any;
}
function slot(over: Record<string, unknown> = {}) {
  return {
    id: 'slot-1', workspaceId: WS, programmeId: PROG, scheduledFor: at('2026-09-18T18:00:00Z'), status: 'PLANNED',
    contentTypeId: 'id-how-to', contentTypeKey: 'how-to', idea: 'Nasıl yapılır: figür boyama', trendSignalId: null, trendTitle: null,
    conceptId: null, campaignItemId: null, quotedCredits: null, spentCredits: 0, error: null, ...over,
  } as any;
}
const typeRow = {
  id: 'id-how-to', workspaceId: WS, key: 'how-to', name: 'Nasıl yapılır', description: 'Üç adım',
  structure: [{ role: 'hook', durationSec: 3, guidance: 'Sonuç önce' }, { role: 'steps', durationSec: 12, guidance: 'Adımlar' }, { junk: true }],
  defaultDurationSec: 15, active: true,
};
const production = (credits: number) => ({ credits, keyframes: { model: DEFAULT_KEYFRAME_MODEL, perFrameCredits: 3, credits: FRAMES, usd: 0.1 } });
const concept = (id: string, hook: string, credits: number | null = 45) => ({
  id, hook, title: `T ${id}`, angle: 'curiosity', shotPlan: credits === null ? { shots: [] } : { shots: [], production: production(credits) },
});

function harness(over: { slot?: unknown; programme?: unknown; campaign?: unknown } = {}) {
  const prisma: any = {
    contentSlot: {
      findFirst: jest.fn().mockResolvedValue(over.slot === undefined ? slot() : over.slot),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    contentProgramme: { findFirst: jest.fn().mockResolvedValue(over.programme === undefined ? programme() : over.programme) },
    contentProgrammeEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    socialCampaign: { findFirst: jest.fn().mockResolvedValue(over.campaign === undefined ? { status: 'ACTIVE', defaultVideoModel: null } : over.campaign) },
    trendSignal: { findFirst: jest.fn().mockResolvedValue(null) },
    contentConcept: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ shotPlan: { shots: [], production: production(45) } }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1'), cancel: jest.fn().mockResolvedValue(true) };
  const runner = { registerHandler: jest.fn() };
  const programmes = { logEvent: jest.fn().mockResolvedValue(undefined) };
  const types = { list: jest.fn().mockResolvedValue([typeRow]) };
  const concepts = {
    planConcepts: jest.fn().mockResolvedValue({ batchId: 'b-1', cold: true, weights: {}, concepts: [concept('c-1', 'Bunu 3 adımda boya'), concept('c-2', 'Figürün rengi neden solar'), concept('c-3', 'Boyamadan önce bunu yap')] }),
    decideByProgramme: jest.fn().mockResolvedValue({ id: 'c-1', status: 'APPROVED' }),
  };
  const storyboard = { request: jest.fn().mockResolvedValue({ conceptId: 'c-1', shots: 2, requested: 2 }) };
  const promotion = { promote: jest.fn().mockResolvedValue({ item: { id: 'item-1', status: 'GENERATING', socialCampaignId: CAMP, scheduledFor: at('2026-09-18T18:00:00Z') }, created: true }) };
  const svc = new SlotProducerService(prisma, scheduledJobs as any, runner as any, programmes as any, types as any, concepts as any, storyboard as any, promotion as any);
  return { svc, prisma, scheduledJobs, runner, programmes, types, concepts, storyboard, promotion };
}
const slotWrites = (prisma: any) => prisma.contentSlot.updateMany.mock.calls.map((c: any[]) => c[0]);
const events = (programmes: any) => programmes.logEvent.mock.calls.map((c: any[]) => ({ kind: c[2], message: c[3], data: c[4] }));
/** A week where `credits` are already spent. */
const spent = (prisma: any, credits: number) =>
  prisma.contentSlot.findMany.mockImplementation(async ({ where }: any) =>
    where?.scheduledFor?.lt ? [{ id: 'x', spentCredits: credits }] : []);
const ESTIMATE = estimateSlotCredits(typeRow as any, null);
const PLAN_COST = BATCH_COST + FRAMES;
const hold = (runAt: Date, slotId = 'slot-1') => ({ reschedule: { runAt, payload: { workspaceId: WS, slotId, programmeId: PROG } } });

describe('hook distinctness', () => {
  it('Jaccard on folded tokens; the first concept far enough from every recent hook wins, else the first', () => {
    expect(hookSimilarity('Bunu 3 adımda boya', 'bunu üç ADIMDA boya')).toBeGreaterThan(0.5);
    expect(hookSimilarity('Bunu 3 adımda boya', 'Figürün rengi neden solar')).toBe(0);
    const batch = [concept('a', 'Bunu 3 adımda boya'), concept('b', 'Figürün rengi neden solar')];
    expect(pickDistinctConcept(batch, ['Bunu 3 adımda boya'])?.id).toBe('b');
    expect(pickDistinctConcept(batch, [])?.id).toBe('a');
    expect(pickDistinctConcept(batch, ['Bunu 3 adımda boya', 'Figürün rengi neden solar'])?.id).toBe('a');
    expect(pickDistinctConcept([], ['x'])).toBeNull();
  });
});

describe('estimateSlotCredits', () => {
  it('prices the clips on the model that will animate the campaign\'s video model, a keyframe per beat, and the batch', () => {
    const frames = estimateMediaCredits(DEFAULT_KEYFRAME_MODEL, {}) * 2; // two real beats; the junk entry is not one
    expect(estimateSlotCredits(typeRow as any, null)).toBe(estimateMediaCredits(animateModelFor(DEFAULT_VIDEO_MODEL), { durationSec: 15 }) + frames + BATCH_COST);
    const premium = estimateSlotCredits(typeRow as any, PREMIUM);
    expect(premium).toBe(estimateMediaCredits(animateModelFor(PREMIUM), { durationSec: 15 }) + frames + BATCH_COST);
    expect(premium).toBeGreaterThan(estimateSlotCredits(typeRow as any, null));
    // A type with no beats still assumes three frames.
    expect(estimateSlotCredits({ defaultDurationSec: 15, structure: [] } as any, null)).toBe(
      estimateMediaCredits(animateModelFor(DEFAULT_VIDEO_MODEL), { durationSec: 15 }) + estimateMediaCredits(DEFAULT_KEYFRAME_MODEL, {}) * 3 + BATCH_COST,
    );
  });
});

describe('SlotProducerService.weekSpend', () => {
  it('sums spentCredits of EVERY slot inside the Istanbul week, whatever its status, optionally leaving one slot out', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([{ id: 'a', spentCredits: 100 }, { id: 'b', spentCredits: 0 }, { id: 'c', spentCredits: 40 }]);
    const out = await svc.weekSpend(WS, PROG, NOW, { excludeSlotId: 'slot-1' });
    expect(out).toEqual({ weekStart: at('2026-09-13T21:00:00Z'), spent: 140 });
    const { where, select } = prisma.contentSlot.findMany.mock.calls[0][0];
    expect(where).toEqual({
      workspaceId: WS, programmeId: PROG, scheduledFor: { gte: at('2026-09-13T21:00:00Z'), lt: at('2026-09-20T21:00:00Z') }, id: { not: 'slot-1' },
    });
    expect(where.status).toBeUndefined();
    expect(select).toEqual({ id: true, spentCredits: true });
  });
});

describe('SlotProducerService.planSlot', () => {
  it('registers both per-slot handlers', () => {
    const { svc, runner } = harness();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(CONTENT_SLOT_PLAN_KIND, expect.any(Function));
    expect(runner.registerHandler).toHaveBeenCalledWith(CONTENT_SLOT_PRODUCE_KIND, expect.any(Function));
  });

  it('plans three concepts under the slot\'s type/trend/brief, keeps the one whose hook is new, books the batch and frames as spend, discards the rest, requests the storyboard and writes IDEATED with the quote', async () => {
    const { svc, prisma, concepts, storyboard, scheduledJobs, programmes } = harness({ slot: slot({ trendSignalId: 't-1', trendTitle: 'Figür challenge' }) });
    prisma.trendSignal.findFirst.mockResolvedValue({ kind: 'HASHTAG', network: 'TIKTOK' });
    prisma.contentSlot.findMany.mockImplementation(async ({ where }: any) => (where?.conceptId ? [{ conceptId: 'old-1' }, { conceptId: 'old-2' }] : []));
    prisma.contentConcept.findMany.mockResolvedValue([{ hook: 'bunu 3 adımda boya!' }, { hook: 'başka bir şey' }]);

    const res = await svc.planSlot(WS, 'slot-1', NOW);

    expect(res).toBeUndefined();
    expect(prisma.contentSlot.findFirst).toHaveBeenCalledWith({ where: { id: 'slot-1', workspaceId: WS } });
    expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith({ where: { id: PROG, workspaceId: WS } });
    expect(prisma.socialCampaign.findFirst).toHaveBeenCalledWith({ where: { id: CAMP, workspaceId: WS }, select: { status: true, defaultVideoModel: true } });
    expect(concepts.planConcepts).toHaveBeenCalledWith(WS, {
      idea: 'Nasıl yapılır: figür boyama',
      count: SLOT_CONCEPT_COUNT,
      socialCampaignId: CAMP,
      personaId: 'persona-1',
      createdById: 'u-1',
      programme: {
        programmeId: PROG,
        slotId: 'slot-1',
        contentType: {
          key: 'how-to', name: 'Nasıl yapılır', description: 'Üç adım', defaultDurationSec: 15,
          structure: [{ role: 'hook', durationSec: 3, guidance: 'Sonuç önce' }, { role: 'steps', durationSec: 12, guidance: 'Adımlar' }],
        },
        trend: { title: 'Figür challenge', kind: 'HASHTAG', network: 'TIKTOK' },
        brief: 'Figurunica figürleri',
      },
    });
    // The hook history: the last 20 slots' concepts, this slot excluded, workspace-scoped.
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS, programmeId: PROG, id: { not: 'slot-1' }, conceptId: { not: null } }, take: 20,
    }));
    expect(prisma.contentConcept.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['old-1', 'old-2'] }, workspaceId: WS } }));
    // c-1's hook is a rewrite of a recent one → c-2 is kept.
    expect(prisma.contentConcept.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-1', 'c-3'] }, workspaceId: WS, status: 'PROPOSED' },
      data: { status: 'DISCARDED', reviewedAt: NOW, reviewedById: `programme:${PROG}`, reviewNote: 'programme: not selected' },
    });
    expect(storyboard.request).toHaveBeenCalledWith(WS, 'c-2', `programme:${PROG}`);
    // The batch and the chosen concept's frames are booked BEFORE the status
    // write, unconditionally: whatever the slot becomes, the week paid for them.
    expect(slotWrites(prisma)).toEqual([
      { where: { id: 'slot-1', workspaceId: WS }, data: { spentCredits: { increment: PLAN_COST } } },
      { where: { id: 'slot-1', workspaceId: WS, status: 'PLANNED' }, data: { status: 'IDEATED', conceptId: 'c-2', quotedCredits: 45, error: null } },
    ]);
    // Produce is re-armed after ideation so it can never run first.
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, kind: CONTENT_SLOT_PRODUCE_KIND, runAt: at('2026-09-18T06:00:00Z'), dedupKey: slotProduceDedup('slot-1'),
    }));
    const ev = events(programmes);
    expect(ev.map((e) => e.kind)).toEqual(['SLOT_IDEATED']);
    expect(ev[0].data).toMatchObject({ slotId: 'slot-1', conceptId: 'c-2', quotedCredits: 45, spent: PLAN_COST, discarded: ['c-1', 'c-3'] });
  });

  it('the spend booked at plan time survives a slot that changed under the job', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.updateMany.mockImplementation(async ({ where }: any) => ({ count: where.status === 'PLANNED' ? 0 : 1 }));
    await svc.planSlot(WS, 'slot-1', NOW);
    expect(slotWrites(prisma)[0]).toEqual({ where: { id: 'slot-1', workspaceId: WS }, data: { spentCredits: { increment: PLAN_COST } } });
    expect(prisma.contentConcept.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: { in: ['c-1'] }, workspaceId: WS, status: 'PROPOSED' } }));
  });

  it('holds the slot for 6h when the catalogue estimate would pass the weekly cap and there is still time — this slot\'s own past spend included', async () => {
    const { svc, prisma, concepts, programmes } = harness();
    spent(prisma, 600 - ESTIMATE + 1);
    const res = await svc.planSlot(WS, 'slot-1', NOW);
    expect(res).toEqual({ reschedule: { runAt: new Date(NOW.getTime() + CAP_RETRY_MS) } });
    expect(concepts.planConcepts).not.toHaveBeenCalled();
    expect(slotWrites(prisma)).toEqual([]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'CAP_HELD', data: { spent: 600 - ESTIMATE + 1, estimate: ESTIMATE, cap: 600 } });
    // A retried slot already paid for a batch: its own row is in the sum.
    const weekRead = prisma.contentSlot.findMany.mock.calls.find((c: any[]) => c[0].where?.scheduledFor?.lt);
    expect(weekRead[0].where.id).toBeUndefined();
  });

  it('estimates on the campaign\'s own video model, so a premium lane is refused at plan time rather than after the frames are drawn', async () => {
    const { svc, prisma, concepts, programmes } = harness({ campaign: { status: 'ACTIVE', defaultVideoModel: PREMIUM } });
    const premium = estimateSlotCredits(typeRow as any, PREMIUM);
    spent(prisma, 600 - premium + 1); // passes the default-model estimate, not the premium one
    expect(600 - premium + 1 + ESTIMATE).toBeLessThanOrEqual(600);
    const res = await svc.planSlot(WS, 'slot-1', NOW);
    expect(res).toEqual({ reschedule: { runAt: new Date(NOW.getTime() + CAP_RETRY_MS) } });
    expect(concepts.planConcepts).not.toHaveBeenCalled();
    expect(events(programmes)[0].data).toMatchObject({ estimate: premium });
  });

  it('skips the slot for the cap when another wait would run past its produce time', async () => {
    const { svc, prisma, concepts, programmes } = harness({ slot: slot({ scheduledFor: new Date(NOW.getTime() + 14 * H) }) });
    spent(prisma, 600 - ESTIMATE + 1);
    const res = await svc.planSlot(WS, 'slot-1', NOW);
    expect(res).toBeUndefined();
    expect(concepts.planConcepts).not.toHaveBeenCalled();
    expect(slotWrites(prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'PLANNED' }, data: { status: 'SKIPPED', error: 'weekly credit cap' } }]);
    expect(events(programmes)[0].kind).toBe('CAP_SKIPPED');
  });

  it('a storyboard that cannot be requested does not cost the slot its concept', async () => {
    const { svc, prisma, storyboard } = harness();
    storyboard.request.mockRejectedValue(new Error('media queue full'));
    await svc.planSlot(WS, 'slot-1', NOW);
    expect(slotWrites(prisma)[1].data.status).toBe('IDEATED');
  });

  it('a concept with no quote is written with quotedCredits null and books only the batch', async () => {
    const { svc, prisma, concepts } = harness();
    concepts.planConcepts.mockResolvedValue({ batchId: 'b', cold: true, weights: {}, concepts: [concept('c-9', 'x', null)] });
    await svc.planSlot(WS, 'slot-1', NOW);
    expect(slotWrites(prisma)[0].data).toEqual({ spentCredits: { increment: BATCH_COST } });
    expect(slotWrites(prisma)[1].data).toMatchObject({ status: 'IDEATED', conceptId: 'c-9', quotedCredits: null });
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
  });

  it('fails the slot (not the job) when planning throws, with the message and an event, and books nothing', async () => {
    const { svc, prisma, concepts, programmes } = harness();
    concepts.planConcepts.mockRejectedValue(new Error('AI not configured'));
    await expect(svc.planSlot(WS, 'slot-1', NOW)).resolves.toBeUndefined();
    expect(slotWrites(prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'PLANNED' }, data: { status: 'FAILED', error: 'AI not configured' } }]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'SLOT_FAILED', data: { slotId: 'slot-1', from: 'PLANNED', error: 'AI not configured' } });
  });

  it('PAUSED programme: waits an hour (same payload) while the produce time is still ahead', async () => {
    const h = harness({ programme: programme({ status: 'PAUSED' }) });
    const res = await h.svc.planSlot(WS, 'slot-1', NOW);
    expect(res).toEqual(hold(new Date(NOW.getTime() + PAUSE_RETRY_MS)));
    expect(h.concepts.planConcepts).not.toHaveBeenCalled();
    expect(h.prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    expect(h.programmes.logEvent).not.toHaveBeenCalled();
  });

  it('PAUSED programme: once the produce time has passed the slot is SKIPPED as missed, with an event', async () => {
    // Produce at T-12h = 06:00 today; it is 12:00.
    const h = harness({ slot: slot({ scheduledFor: at('2026-09-16T18:00:00Z') }), programme: programme({ status: 'PAUSED' }) });
    const res = await h.svc.planSlot(WS, 'slot-1', NOW);
    expect(res).toBeUndefined();
    expect(slotWrites(h.prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'PLANNED' }, data: { status: 'SKIPPED', error: MISSED_WHILE_PAUSED } }]);
    expect(events(h.programmes)[0]).toMatchObject({ kind: 'SLOT_SKIPPED', data: { slotId: 'slot-1', from: 'PLANNED', reason: MISSED_WHILE_PAUSED } });
  });

  it('exits silently (job ends) for a slot that is not PLANNED, a killed programme, or a foreign slot', async () => {
    for (const h of [
      harness({ slot: slot({ status: 'IDEATED' }) }),
      harness({ programme: programme({ status: 'KILLED', killSwitch: true }) }),
      harness({ programme: programme({ killSwitch: true }) }),
      harness({ slot: null }),
    ]) {
      await expect(h.svc.planSlot(WS, 'slot-1', NOW)).resolves.toBeUndefined();
      expect(h.concepts.planConcepts).not.toHaveBeenCalled();
      expect(h.prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    }
  });
});

describe('SlotProducerService.produceSlot', () => {
  const ideated = (over: Record<string, unknown> = {}) => slot({ status: 'IDEATED', conceptId: 'c-2', quotedCredits: 45, spentCredits: PLAN_COST, ...over });

  it('claims the slot FIRST (IDEATED → PRODUCING), then lets the programme decide, promotes AT THE SLOT TIME and books the clips (quote minus frames) with the item', async () => {
    const { svc, prisma, concepts, promotion, programmes } = harness({ slot: ideated() });
    await svc.produceSlot(WS, 'slot-1', NOW);
    expect(concepts.decideByProgramme).toHaveBeenCalledWith(WS, 'c-2', PROG, CAMP);
    expect(promotion.promote).toHaveBeenCalledWith(WS, 'c-2', { socialCampaignId: CAMP, scheduledFor: at('2026-09-18T18:00:00Z') });
    expect(slotWrites(prisma)).toEqual([
      { where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' }, data: { status: 'PRODUCING' } },
      { where: { id: 'slot-1', workspaceId: WS, status: 'PRODUCING' }, data: { campaignItemId: 'item-1', error: null, spentCredits: { increment: 45 - FRAMES } } },
    ]);
    // The claim precedes the decision and the promotion — the race door.
    expect(prisma.contentSlot.updateMany.mock.invocationCallOrder[0]).toBeLessThan(concepts.decideByProgramme.mock.invocationCallOrder[0]);
    expect(prisma.contentConcept.findFirst).toHaveBeenCalledWith({ where: { id: 'c-2', workspaceId: WS }, select: { shotPlan: true } });
    expect(events(programmes)[0]).toMatchObject({ kind: 'SLOT_PRODUCING', data: { slotId: 'slot-1', conceptId: 'c-2', campaignItemId: 'item-1', spent: 45 - FRAMES } });
  });

  it('a claim that finds nothing (edited or skipped under the job) buys nothing and logs nothing', async () => {
    const { svc, prisma, concepts, promotion, programmes } = harness({ slot: ideated() });
    prisma.contentSlot.updateMany.mockResolvedValue({ count: 0 });
    await svc.produceSlot(WS, 'slot-1', NOW);
    expect(concepts.decideByProgramme).not.toHaveBeenCalled();
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(programmes.logEvent).not.toHaveBeenCalled();
    expect(slotWrites(prisma)).toHaveLength(1);
  });

  it('skips the slot and gives its concept back when the quote would pass the weekly cap', async () => {
    const { svc, prisma, concepts, promotion, programmes } = harness({ slot: ideated() });
    spent(prisma, 580); // + 45 > 600
    await svc.produceSlot(WS, 'slot-1', NOW);
    expect(concepts.decideByProgramme).not.toHaveBeenCalled();
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(prisma.contentConcept.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['c-2'] }, workspaceId: WS, status: 'PROPOSED' }, data: expect.objectContaining({ status: 'DISCARDED' }),
    }));
    expect(slotWrites(prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' }, data: { status: 'SKIPPED', error: 'weekly credit cap' } }]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'CAP_SKIPPED', data: { spent: 580, wanted: 45 } });
    // The cap check leaves this slot's own spend out: its quote already carries its frames.
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { not: 'slot-1' } }) }));
  });

  it('REFUSES a slot with no quote: FAILED by name, concept discarded, nothing bought', async () => {
    const { svc, prisma, concepts, promotion, programmes } = harness({ slot: ideated({ quotedCredits: null }) });
    spent(prisma, 0);
    await svc.produceSlot(WS, 'slot-1', NOW);
    expect(concepts.decideByProgramme).not.toHaveBeenCalled();
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(prisma.contentConcept.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['c-2'] }, workspaceId: WS, status: 'PROPOSED' } }));
    expect(slotWrites(prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' }, data: { status: 'FAILED', error: NO_QUOTE_ERROR } }]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'SLOT_FAILED', data: { from: 'IDEATED', error: NO_QUOTE_ERROR } });
  });

  it('fails the slot from PRODUCING when the decision or the promotion throws after the claim', async () => {
    const { svc, prisma, promotion, programmes } = harness({ slot: ideated() });
    promotion.promote.mockRejectedValue(new Error('campaign not active'));
    await svc.produceSlot(WS, 'slot-1', NOW);
    expect(slotWrites(prisma)).toEqual([
      { where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' }, data: { status: 'PRODUCING' } },
      { where: { id: 'slot-1', workspaceId: WS, status: 'PRODUCING' }, data: { status: 'FAILED', error: 'campaign not active' } },
    ]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'SLOT_FAILED', data: { from: 'PRODUCING' } });
  });

  it('lane paused by hand (campaign PAUSED, programme ACTIVE): waits an hour and logs LANE_PAUSED once per slot', async () => {
    const h = harness({ slot: ideated(), campaign: { status: 'PAUSED', defaultVideoModel: null } });
    const res = await h.svc.produceSlot(WS, 'slot-1', NOW);
    expect(res).toEqual(hold(new Date(NOW.getTime() + PAUSE_RETRY_MS)));
    expect(h.concepts.decideByProgramme).not.toHaveBeenCalled();
    expect(h.prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    expect(events(h.programmes)).toEqual([expect.objectContaining({ kind: 'LANE_PAUSED', data: expect.objectContaining({ slotId: 'slot-1', socialCampaignId: CAMP }) })]);
    expect(h.prisma.contentProgrammeEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS, programmeId: PROG, kind: 'LANE_PAUSED', data: { path: ['slotId'], equals: 'slot-1' } },
    }));
    // Second hour: the event exists, nothing new is logged.
    h.programmes.logEvent.mockClear();
    h.prisma.contentProgrammeEvent.findFirst.mockResolvedValue({ id: 'ev-1' });
    expect(await h.svc.produceSlot(WS, 'slot-1', new Date(NOW.getTime() + PAUSE_RETRY_MS))).toEqual(hold(new Date(NOW.getTime() + 2 * PAUSE_RETRY_MS)));
    expect(h.programmes.logEvent).not.toHaveBeenCalled();
  });

  it('lane paused past the slot\'s own time: SKIPPED as missed', async () => {
    const h = harness({ slot: ideated({ scheduledFor: at('2026-09-16T11:00:00Z') }), campaign: { status: 'PAUSED', defaultVideoModel: null } });
    await h.svc.produceSlot(WS, 'slot-1', NOW);
    expect(slotWrites(h.prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' }, data: { status: 'SKIPPED', error: MISSED_WHILE_PAUSED } }]);
    expect(h.prisma.contentConcept.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['c-2'] }, workspaceId: WS, status: 'PROPOSED' } }));
  });

  it('PAUSED programme: waits while the produce time is ahead; SKIPPED as missed (concept discarded) once it is behind', async () => {
    const ahead = harness({ slot: ideated(), programme: programme({ status: 'PAUSED' }) });
    expect(await ahead.svc.produceSlot(WS, 'slot-1', NOW)).toEqual(hold(new Date(NOW.getTime() + PAUSE_RETRY_MS)));
    expect(ahead.prisma.contentSlot.updateMany).not.toHaveBeenCalled();

    const behind = harness({ slot: ideated({ scheduledFor: at('2026-09-16T18:00:00Z') }), programme: programme({ status: 'PAUSED' }) });
    expect(await behind.svc.produceSlot(WS, 'slot-1', NOW)).toBeUndefined();
    expect(slotWrites(behind.prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' }, data: { status: 'SKIPPED', error: MISSED_WHILE_PAUSED } }]);
    expect(behind.prisma.contentConcept.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['c-2'] }, workspaceId: WS, status: 'PROPOSED' }, data: expect.objectContaining({ reviewNote: `programme: ${MISSED_WHILE_PAUSED}` }),
    }));
    expect(events(behind.programmes)[0]).toMatchObject({ kind: 'SLOT_SKIPPED', data: { from: 'IDEATED', reason: MISSED_WHILE_PAUSED } });
    expect(behind.concepts.decideByProgramme).not.toHaveBeenCalled();
  });

  it('exits silently unless the slot is IDEATED with a concept and the programme is not killed', async () => {
    for (const h of [
      harness({ slot: slot({ status: 'PLANNED' }) }),
      harness({ slot: slot({ status: 'IDEATED', conceptId: null }) }),
      harness({ slot: ideated(), programme: programme({ killSwitch: true }) }),
      harness({ slot: ideated(), programme: programme({ status: 'KILLED', killSwitch: true }) }),
    ]) {
      await expect(h.svc.produceSlot(WS, 'slot-1', NOW)).resolves.toBeUndefined();
      expect(h.concepts.decideByProgramme).not.toHaveBeenCalled();
      expect(h.prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    }
  });
});
