import {
  CAP_RETRY_MS,
  SLOT_CONCEPT_COUNT,
  SlotProducerService,
  hookSimilarity,
  pickDistinctConcept,
} from './slot-producer.service';
import { CONTENT_SLOT_PLAN_KIND, CONTENT_SLOT_PRODUCE_KIND, slotProduceDedup } from './programme-planner.service';

const WS = 'ws-1';
const PROG = 'prog-1';
const CAMP = 'camp-1';
/** Wednesday 12:00 UTC. */
const NOW = new Date('2026-09-16T12:00:00Z');
const H = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);

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
    conceptId: null, campaignItemId: null, quotedCredits: null, error: null, ...over,
  } as any;
}
const typeRow = {
  id: 'id-how-to', workspaceId: WS, key: 'how-to', name: 'Nasıl yapılır', description: 'Üç adım',
  structure: [{ role: 'hook', durationSec: 3, guidance: 'Sonuç önce' }, { role: 'steps', durationSec: 12, guidance: 'Adımlar' }, { junk: true }],
  defaultDurationSec: 15, active: true,
};
const concept = (id: string, hook: string, credits: number | null = 45) => ({
  id, hook, title: `T ${id}`, angle: 'curiosity', shotPlan: credits === null ? { shots: [] } : { shots: [], production: { credits } },
});

function harness(over: { slot?: unknown; programme?: unknown } = {}) {
  const prisma: any = {
    contentSlot: {
      findFirst: jest.fn().mockResolvedValue(over.slot === undefined ? slot() : over.slot),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    contentProgramme: { findFirst: jest.fn().mockResolvedValue(over.programme === undefined ? programme() : over.programme) },
    trendSignal: { findFirst: jest.fn().mockResolvedValue(null) },
    contentConcept: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
/** A week where 500 credits are already committed. */
const spent = (prisma: any, credits: number) =>
  prisma.contentSlot.findMany.mockImplementation(async ({ where }: any) =>
    where?.scheduledFor?.lt ? [{ id: 'x', quotedCredits: credits }] : []);

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

describe('SlotProducerService.weekSpend', () => {
  it('sums the quoted credits of committed slots inside the Istanbul week, optionally leaving one slot out', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([{ id: 'a', quotedCredits: 100 }, { id: 'b', quotedCredits: null }, { id: 'c', quotedCredits: 40 }]);
    const out = await svc.weekSpend(WS, PROG, NOW, { excludeSlotId: 'slot-1' });
    expect(out).toEqual({ weekStart: at('2026-09-13T21:00:00Z'), spent: 140 });
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: WS, programmeId: PROG, status: { in: ['IDEATED', 'PRODUCING', 'READY', 'PUBLISHED', 'MEASURED'] },
        scheduledFor: { gte: at('2026-09-13T21:00:00Z'), lt: at('2026-09-20T21:00:00Z') }, id: { not: 'slot-1' },
      },
    }));
  });
});

describe('SlotProducerService.planSlot', () => {
  it('registers both per-slot handlers', () => {
    const { svc, runner } = harness();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(CONTENT_SLOT_PLAN_KIND, expect.any(Function));
    expect(runner.registerHandler).toHaveBeenCalledWith(CONTENT_SLOT_PRODUCE_KIND, expect.any(Function));
  });

  it('plans three concepts under the slot\'s type/trend/brief, keeps the one whose hook is new, discards the rest, requests the storyboard and writes IDEATED with the quote', async () => {
    const { svc, prisma, concepts, storyboard, scheduledJobs, programmes } = harness({ slot: slot({ trendSignalId: 't-1', trendTitle: 'Figür challenge' }) });
    prisma.trendSignal.findFirst.mockResolvedValue({ kind: 'HASHTAG', network: 'TIKTOK' });
    prisma.contentSlot.findMany.mockImplementation(async ({ where }: any) => (where?.conceptId ? [{ conceptId: 'old-1' }, { conceptId: 'old-2' }] : []));
    prisma.contentConcept.findMany.mockResolvedValue([{ hook: 'bunu 3 adımda boya!' }, { hook: 'başka bir şey' }]);

    const res = await svc.planSlot(WS, 'slot-1', NOW);

    expect(res).toBeUndefined();
    expect(prisma.contentSlot.findFirst).toHaveBeenCalledWith({ where: { id: 'slot-1', workspaceId: WS } });
    expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith({ where: { id: PROG, workspaceId: WS } });
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
    expect(slotWrites(prisma)).toEqual([{
      where: { id: 'slot-1', workspaceId: WS, status: 'PLANNED' },
      data: { status: 'IDEATED', conceptId: 'c-2', quotedCredits: 45, error: null },
    }]);
    // Produce is re-armed after ideation so it can never run first.
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, kind: CONTENT_SLOT_PRODUCE_KIND, runAt: at('2026-09-18T06:00:00Z'), dedupKey: slotProduceDedup('slot-1'),
    }));
    const ev = events(programmes);
    expect(ev.map((e) => e.kind)).toEqual(['SLOT_IDEATED']);
    expect(ev[0].data).toMatchObject({ slotId: 'slot-1', conceptId: 'c-2', quotedCredits: 45, discarded: ['c-1', 'c-3'] });
  });

  it('holds the slot for 6h when the estimate would pass the weekly cap and there is still time', async () => {
    const { svc, prisma, concepts, programmes } = harness();
    spent(prisma, 560); // + (15·3 + 9 = 54) = 614 > 600
    const res = await svc.planSlot(WS, 'slot-1', NOW);
    expect(res).toEqual({ reschedule: { runAt: new Date(NOW.getTime() + CAP_RETRY_MS) } });
    expect(concepts.planConcepts).not.toHaveBeenCalled();
    expect(slotWrites(prisma)).toEqual([]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'CAP_HELD', data: { spent: 560, estimate: 54, cap: 600 } });
  });

  it('skips the slot for the cap when another wait would run past its produce time', async () => {
    const { svc, prisma, concepts, programmes } = harness({ slot: slot({ scheduledFor: new Date(NOW.getTime() + 14 * H) }) });
    spent(prisma, 560);
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
    expect(slotWrites(prisma)[0].data.status).toBe('IDEATED');
  });

  it('a concept with no quote is written with quotedCredits null', async () => {
    const { svc, prisma, concepts } = harness();
    concepts.planConcepts.mockResolvedValue({ batchId: 'b', cold: true, weights: {}, concepts: [concept('c-9', 'x', null)] });
    await svc.planSlot(WS, 'slot-1', NOW);
    expect(slotWrites(prisma)[0].data).toMatchObject({ status: 'IDEATED', conceptId: 'c-9', quotedCredits: null });
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
  });

  it('fails the slot (not the job) when planning throws, with the message and an event', async () => {
    const { svc, prisma, concepts, programmes } = harness();
    concepts.planConcepts.mockRejectedValue(new Error('AI not configured'));
    await expect(svc.planSlot(WS, 'slot-1', NOW)).resolves.toBeUndefined();
    expect(slotWrites(prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'PLANNED' }, data: { status: 'FAILED', error: 'AI not configured' } }]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'SLOT_FAILED', data: { slotId: 'slot-1', from: 'PLANNED', error: 'AI not configured' } });
  });

  it('exits silently for a slot that is not PLANNED, a paused programme, a kill switch, or a foreign slot', async () => {
    for (const h of [
      harness({ slot: slot({ status: 'IDEATED' }) }),
      harness({ programme: programme({ status: 'PAUSED' }) }),
      harness({ programme: programme({ killSwitch: true }) }),
      harness({ slot: null }),
    ]) {
      await h.svc.planSlot(WS, 'slot-1', NOW);
      expect(h.concepts.planConcepts).not.toHaveBeenCalled();
      expect(h.prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    }
  });
});

describe('SlotProducerService.produceSlot', () => {
  const ideated = () => slot({ status: 'IDEATED', conceptId: 'c-2', quotedCredits: 45 });

  it('lets the programme decide the concept, promotes it onto the campaign AT THE SLOT TIME and writes PRODUCING with the item', async () => {
    const { svc, prisma, concepts, promotion, programmes } = harness({ slot: ideated() });
    await svc.produceSlot(WS, 'slot-1', NOW);
    expect(concepts.decideByProgramme).toHaveBeenCalledWith(WS, 'c-2', PROG, CAMP);
    expect(promotion.promote).toHaveBeenCalledWith(WS, 'c-2', { socialCampaignId: CAMP, scheduledFor: at('2026-09-18T18:00:00Z') });
    expect(slotWrites(prisma)).toEqual([{
      where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' },
      data: { status: 'PRODUCING', campaignItemId: 'item-1', error: null },
    }]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'SLOT_PRODUCING', data: { slotId: 'slot-1', conceptId: 'c-2', campaignItemId: 'item-1' } });
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
    // The cap check leaves this slot's own quote out of "spent".
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { not: 'slot-1' } }) }));
  });

  it('fails the slot when the decision or the promotion throws', async () => {
    const { svc, prisma, promotion, programmes } = harness({ slot: ideated() });
    promotion.promote.mockRejectedValue(new Error('campaign not active'));
    await svc.produceSlot(WS, 'slot-1', NOW);
    expect(slotWrites(prisma)).toEqual([{ where: { id: 'slot-1', workspaceId: WS, status: 'IDEATED' }, data: { status: 'FAILED', error: 'campaign not active' } }]);
    expect(events(programmes)[0]).toMatchObject({ kind: 'SLOT_FAILED', data: { from: 'IDEATED' } });
  });

  it('exits silently unless the slot is IDEATED with a concept and the programme is live', async () => {
    for (const h of [
      harness({ slot: slot({ status: 'PLANNED' }) }),
      harness({ slot: slot({ status: 'IDEATED', conceptId: null }) }),
      harness({ slot: ideated(), programme: programme({ killSwitch: true }) }),
      harness({ slot: ideated(), programme: programme({ status: 'PAUSED' }) }),
    ]) {
      await h.svc.produceSlot(WS, 'slot-1', NOW);
      expect(h.concepts.decideByProgramme).not.toHaveBeenCalled();
      expect(h.prisma.contentSlot.updateMany).not.toHaveBeenCalled();
    }
  });
});
