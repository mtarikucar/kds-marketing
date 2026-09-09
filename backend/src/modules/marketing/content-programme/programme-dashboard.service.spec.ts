import { NotFoundException } from '@nestjs/common';
import { ProgrammeDashboardService } from './programme-dashboard.service';

const WS = 'ws-1';
const NOW = new Date('2026-09-08T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function programmeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'prog-1',
    workspaceId: WS,
    name: 'Sonbahar',
    status: 'ACTIVE',
    socialCampaignId: 'camp-1',
    goal: 'COMPOSITE',
    brief: 'Figurunica 3D baskı figürleri',
    personaId: null,
    perWeek: 5,
    weeklyCreditCap: 600,
    explorationRate: 0.15,
    maturityHours: 72,
    halfLifeDays: 30,
    editWindowHours: 2,
    lookaheadDays: 14,
    planLeadHours: 36,
    produceLeadHours: 12,
    seedWeeks: 2,
    phase: 'LEARN',
    killSwitch: false,
    lastPlannedAt: null,
    lastMeasuredAt: null,
    lastReweightedAt: new Date('2026-09-07T00:00:00Z'),
    createdById: 'u-1',
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function slotRow(over: Record<string, unknown> = {}) {
  return {
    id: 'slot-1',
    workspaceId: WS,
    programmeId: 'prog-1',
    scheduledFor: new Date(NOW.getTime() + 2 * DAY),
    status: 'PLANNED',
    contentTypeId: 't-hook',
    contentTypeKey: 'hook-demo',
    selectionReason: 'seed round-robin',
    trendSignalId: null,
    trendTitle: null,
    idea: 'a figure emerging from the printer',
    conceptId: null,
    campaignItemId: null,
    socialPostId: null,
    quotedCredits: null,
    spentCredits: 0,
    editableUntil: new Date(NOW.getTime() + 2 * DAY - 2 * 60 * 60 * 1000),
    publishedAt: null,
    measuredAt: null,
    reward: null,
    rewardBreakdown: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function typeRow(over: Record<string, unknown> = {}) {
  return {
    id: 't-hook',
    workspaceId: WS,
    key: 'hook-demo',
    name: 'Hook + demo',
    description: 'a hook, then the product',
    structure: [{ role: 'hook', durationSec: 3, guidance: '' }],
    defaultDurationSec: 15,
    networks: ['INSTAGRAM', 'TIKTOK'],
    minShare: 0.05,
    maxShare: 0.4,
    active: true,
    isSeed: true,
    ordinal: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function statRow(over: Record<string, unknown> = {}) {
  return {
    id: 'st-1',
    workspaceId: WS,
    programmeId: 'prog-1',
    contentTypeId: 't-hook',
    contentTypeKey: 'hook-demo',
    network: 'ALL',
    samples: 4,
    alpha: 3.2,
    beta: 1.8,
    meanReward: 0.64,
    weight: 0.35,
    computedAt: new Date('2026-09-07T00:00:00Z'),
    ...over,
  };
}

function harness(over: {
  slots?: unknown[];
  types?: unknown[];
  stats?: unknown[];
  concepts?: unknown[];
  trends?: unknown[];
  events?: unknown[];
} = {}) {
  const prisma: any = {
    contentSlot: {
      findMany: jest.fn().mockResolvedValue(over.slots ?? []),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        const all = (over.slots ?? []) as Array<Record<string, unknown>>;
        return all.find((s) => s.id === where.id && s.workspaceId === where.workspaceId) ?? null;
      }),
    },
    contentTypeStat: { findMany: jest.fn().mockResolvedValue(over.stats ?? []) },
    contentConcept: { findMany: jest.fn().mockResolvedValue(over.concepts ?? []) },
  };
  const programmes = { events: jest.fn().mockResolvedValue(over.events ?? []) };
  const types = { list: jest.fn().mockResolvedValue(over.types ?? [typeRow()]) };
  const trends = { top: jest.fn().mockResolvedValue(over.trends ?? []) };
  const producer = { weekSpend: jest.fn().mockResolvedValue({ weekStart: new Date('2026-09-07T00:00:00Z'), spent: 120 }) };
  const planner = { brandKeywords: jest.fn().mockResolvedValue(['figurunica', '3d', 'baskı']) };
  const svc = new ProgrammeDashboardService(
    prisma,
    programmes as never,
    types as never,
    trends as never,
    producer as never,
    planner as never,
  );
  return { svc, prisma, programmes, types, trends, producer, planner };
}

describe('ProgrammeDashboardService.toSlotView', () => {
  const names = new Map([['hook-demo', 'Hook + demo']]);

  it('projects the row, resolves the type name, and marks an open slot inside its window editable', () => {
    const { svc } = harness();
    const view = svc.toSlotView(slotRow() as never, names, new Map(), NOW);
    expect(view).toMatchObject({
      id: 'slot-1',
      status: 'PLANNED',
      contentTypeKey: 'hook-demo',
      contentTypeName: 'Hook + demo',
      selectionReason: 'seed round-robin',
      trendTitle: null,
      idea: 'a figure emerging from the printer',
      conceptId: null,
      quotedCredits: null,
      spentCredits: 0,
      editable: true,
      publishedAt: null,
      reward: null,
      error: null,
      concept: null,
    });
    expect(view.scheduledFor).toBe(slotRow().scheduledFor.toISOString());
    expect(view.editableUntil).toBe(slotRow().editableUntil.toISOString());
  });

  it('carries what the slot has actually cost — on a SKIPPED row too, because the week paid for it', () => {
    const { svc } = harness();
    expect(svc.toSlotView(slotRow({ status: 'SKIPPED', quotedCredits: 45, spentCredits: 22 }) as never, names, new Map(), NOW)).toMatchObject({ quotedCredits: 45, spentCredits: 22 });
  });

  it('is NOT editable once the window has closed, whatever the status', () => {
    const { svc } = harness();
    const past = slotRow({ editableUntil: new Date(NOW.getTime() - 1000) });
    expect(svc.toSlotView(past as never, names, new Map(), NOW).editable).toBe(false);
  });

  it('is NOT editable in a state where money has been spent or the piece is out', () => {
    const { svc } = harness();
    for (const status of ['PRODUCING', 'PUBLISHED', 'MEASURED', 'SKIPPED', 'FAILED']) {
      expect(svc.toSlotView(slotRow({ status }) as never, names, new Map(), NOW).editable).toBe(false);
    }
    for (const status of ['PLANNED', 'IDEATED', 'READY']) {
      expect(svc.toSlotView(slotRow({ status }) as never, names, new Map(), NOW).editable).toBe(true);
    }
  });

  it('falls back to the key when the type was deleted, and attaches the concept summary when present', () => {
    const { svc } = harness();
    const concepts = new Map([['c-1', { title: 'T', hook: 'H', angle: 'A' }]]);
    const view = svc.toSlotView(slotRow({ contentTypeKey: 'gone', conceptId: 'c-1' }) as never, names, concepts, NOW);
    expect(view.contentTypeName).toBe('gone');
    expect(view.concept).toEqual({ title: 'T', hook: 'H', angle: 'A' });
  });
});

describe('ProgrammeDashboardService.slots', () => {
  it('reads the window workspace-scoped, in calendar order, and resolves concepts in ONE query', async () => {
    const slots = [slotRow(), slotRow({ id: 'slot-2', conceptId: 'c-2', scheduledFor: new Date(NOW.getTime() + 3 * DAY) })];
    const { svc, prisma } = harness({ slots, concepts: [{ id: 'c-2', title: 'T2', hook: 'H2', angle: 'A2' }] });
    const from = new Date(NOW.getTime() - DAY);
    const to = new Date(NOW.getTime() + 14 * DAY);
    const views = await svc.slots(WS, 'prog-1', from, to, NOW);
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS, programmeId: 'prog-1', scheduledFor: { gte: from, lte: to } },
        orderBy: { scheduledFor: 'asc' },
      }),
    );
    expect(prisma.contentConcept.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.contentConcept.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-2'] }, workspaceId: WS },
      select: { id: true, title: true, hook: true, angle: true },
    });
    expect(views.map((v) => v.id)).toEqual(['slot-1', 'slot-2']);
    expect(views[1].concept).toEqual({ title: 'T2', hook: 'H2', angle: 'A2' });
  });

  it('skips the concept query entirely when no slot has a concept', async () => {
    const { svc, prisma } = harness({ slots: [slotRow()] });
    await svc.slots(WS, 'prog-1', NOW, NOW, NOW);
    expect(prisma.contentConcept.findMany).not.toHaveBeenCalled();
  });
});

describe('ProgrammeDashboardService.slotView', () => {
  it('returns the one slot when it is the programme\'s, and 404s a slot of another programme or workspace', async () => {
    const { svc } = harness({ slots: [slotRow(), slotRow({ id: 'slot-x', programmeId: 'prog-other' })] });
    await expect(svc.slotView(WS, 'prog-1', 'slot-1', NOW)).resolves.toMatchObject({ id: 'slot-1' });
    await expect(svc.slotView(WS, 'prog-1', 'slot-x', NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.slotView('ws-other', 'prog-1', 'slot-1', NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ProgrammeDashboardService.typeViews', () => {
  it('joins each type to its latest ALL stat and to its share of the upcoming, non-skipped calendar', async () => {
    const types = [typeRow(), typeRow({ id: 't-story', key: 'story', name: 'Story', ordinal: 1 })];
    const upcoming = [
      slotRow({ id: 's1', contentTypeKey: 'hook-demo' }),
      slotRow({ id: 's2', contentTypeKey: 'hook-demo' }),
      slotRow({ id: 's3', contentTypeKey: 'story' }),
      slotRow({ id: 's4', contentTypeKey: 'story', status: 'SKIPPED' }),
    ];
    const { svc, prisma } = harness({ types, stats: [statRow()], slots: upcoming.filter((s) => s.status !== 'SKIPPED') });
    const views = await svc.typeViews(WS, 'prog-1', NOW);
    expect(prisma.contentTypeStat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, programmeId: 'prog-1', network: 'ALL' }, distinct: ['contentTypeKey'] }),
    );
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, programmeId: 'prog-1', scheduledFor: { gte: NOW }, status: { not: 'SKIPPED' } } }),
    );
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      id: 't-hook', key: 'hook-demo', name: 'Hook + demo', active: true, minShare: 0.05, maxShare: 0.4,
      defaultDurationSec: 15, networks: ['INSTAGRAM', 'TIKTOK'], weight: 0.35, samples: 4, meanReward: 0.64,
    });
    expect(views[0].plannedShare).toBeCloseTo(2 / 3);
    // A type with no stat yet: weight 0, no samples, no mean — the panel shows "not learned yet".
    expect(views[1]).toMatchObject({ key: 'story', weight: 0, samples: 0, meanReward: null });
    expect(views[1].plannedShare).toBeCloseTo(1 / 3);
  });

  it('reports plannedShare 0 (not NaN) when nothing is planned', async () => {
    const { svc } = harness({ types: [typeRow()], slots: [] });
    const [v] = await svc.typeViews(WS, 'prog-1', NOW);
    expect(v.plannedShare).toBe(0);
  });
});

describe('ProgrammeDashboardService.learning', () => {
  it('lists the latest cell per type×network (ALL first) and the last 12 ALL reweights oldest-first', async () => {
    const t1 = new Date('2026-09-01T00:00:00Z');
    const t2 = new Date('2026-09-07T00:00:00Z');
    const latest = [
      statRow({ id: 'a', network: 'ALL', computedAt: t2, weight: 0.35 }),
      statRow({ id: 'b', network: 'INSTAGRAM', computedAt: t2, weight: 0.3, samples: 2 }),
      statRow({ id: 'c', contentTypeKey: 'story', contentTypeId: 't-story', network: 'ALL', computedAt: t2, weight: 0.65 }),
    ];
    const history = [
      statRow({ id: 'a', computedAt: t2, weight: 0.35 }),
      statRow({ id: 'c', contentTypeKey: 'story', computedAt: t2, weight: 0.65 }),
      statRow({ id: 'a0', computedAt: t1, weight: 0.5 }),
      statRow({ id: 'c0', contentTypeKey: 'story', computedAt: t1, weight: 0.5 }),
    ];
    const { svc, prisma } = harness();
    prisma.contentTypeStat.findMany.mockResolvedValueOnce(latest).mockResolvedValueOnce(history);
    const view = await svc.learning(WS, programmeRow() as never);
    expect(view.phase).toBe('LEARN');
    expect(view.lastReweightedAt).toBe('2026-09-07T00:00:00.000Z');
    expect(view.networks).toEqual(['ALL', 'INSTAGRAM']);
    expect(view.rows).toHaveLength(3);
    expect(view.rows[0]).toMatchObject({ typeKey: 'hook-demo', network: 'ALL', samples: 4, alpha: 3.2, beta: 1.8, meanReward: 0.64, weight: 0.35, computedAt: t2.toISOString() });
    expect(view.history).toEqual([
      { computedAt: t1.toISOString(), weights: { 'hook-demo': 0.5, story: 0.5 } },
      { computedAt: t2.toISOString(), weights: { 'hook-demo': 0.35, story: 0.65 } },
    ]);
    // Both reads are the programme's own.
    for (const call of prisma.contentTypeStat.findMany.mock.calls) {
      expect(call[0].where).toMatchObject({ workspaceId: WS, programmeId: 'prog-1' });
    }
  });

  it('keeps only the newest 12 reweight points', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => statRow({ id: `r${i}`, computedAt: new Date(NOW.getTime() - i * DAY), weight: i / 100 }));
    const { svc, prisma } = harness();
    prisma.contentTypeStat.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const view = await svc.learning(WS, programmeRow() as never);
    expect(view.history).toHaveLength(12);
    expect(new Date(view.history[0].computedAt).getTime()).toBeLessThan(new Date(view.history[11].computedAt).getTime());
    expect(view.history[11].computedAt).toBe(NOW.toISOString());
  });
});

describe('ProgrammeDashboardService.trendViews', () => {
  it('asks the planner for the brand keywords and ranks the region\'s signals by suggestion', async () => {
    const signal = {
      id: 'tr-1', region: 'TR', network: 'TIKTOK', kind: 'HASHTAG', title: '3d baskı', ref: '#3dbaski',
      score: 90, source: 'apify', observedAt: new Date('2026-09-08T00:00:00Z'), halfLifeHours: 48, raw: null, createdAt: NOW, updatedAt: NOW,
    };
    const { svc, trends, planner } = harness({ trends: [{ signal, decayed: 75.6, relevance: 0.5, suggestion: 49.1 }] });
    const views = await svc.trendViews(WS, programmeRow() as never, NOW);
    expect(planner.brandKeywords).toHaveBeenCalledWith(WS, expect.objectContaining({ id: 'prog-1' }));
    expect(trends.top).toHaveBeenCalledWith('TR', expect.objectContaining({ brandKeywords: ['figurunica', '3d', 'baskı'], now: NOW }));
    expect(views).toEqual([
      { id: 'tr-1', network: 'TIKTOK', kind: 'HASHTAG', title: '3d baskı', ref: '#3dbaski', decayed: 75.6, relevance: 0.5, suggestion: 49.1, observedAt: '2026-09-08T00:00:00.000Z' },
    ]);
  });
});

describe('ProgrammeDashboardService.events', () => {
  it('projects the programme log through the programme service, newest first as it comes', async () => {
    const ev = { id: 'e-1', workspaceId: WS, programmeId: 'prog-1', kind: 'PLAN', message: 'planned 5', data: { n: 5 }, createdAt: NOW };
    const { svc, programmes } = harness({ events: [ev] });
    const views = await svc.events(WS, 'prog-1', 30);
    expect(programmes.events).toHaveBeenCalledWith(WS, 'prog-1', 30);
    expect(views).toEqual([{ id: 'e-1', kind: 'PLAN', message: 'planned 5', data: { n: 5 }, createdAt: NOW.toISOString() }]);
  });
});

describe('ProgrammeDashboardService.dashboard', () => {
  it('assembles the composite: switches, week spend against the cap, the ±window of slots, types, learning, trends, last 30 events', async () => {
    const { svc, prisma, producer, programmes } = harness({ slots: [slotRow()] });
    const p = programmeRow({ status: 'PAUSED', killSwitch: false });
    const d = await svc.dashboard(WS, p as never, NOW);
    expect(d.phase).toBe('LEARN');
    expect(d.status).toBe('PAUSED');
    expect(d.killSwitch).toBe(false);
    expect(producer.weekSpend).toHaveBeenCalledWith(WS, 'prog-1', NOW);
    expect(d.week).toEqual({ weekStart: '2026-09-07T00:00:00.000Z', spent: 120, cap: 600 });
    // The slot window: yesterday to lookaheadDays ahead.
    const slotCall = prisma.contentSlot.findMany.mock.calls.find((c: any) => c[0].where.scheduledFor?.lte);
    expect(slotCall[0].where.scheduledFor).toEqual({ gte: new Date(NOW.getTime() - DAY), lte: new Date(NOW.getTime() + 14 * DAY) });
    expect(d.slots).toHaveLength(1);
    expect(d.types).toHaveLength(1);
    expect(d.learning.phase).toBe('LEARN');
    expect(d.trends).toEqual([]);
    expect(programmes.events).toHaveBeenCalledWith(WS, 'prog-1', 30);
    expect(d.events).toEqual([]);
  });
});
