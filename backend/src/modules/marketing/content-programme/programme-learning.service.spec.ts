import {
  CONTENT_PROGRAMME_LEARN_KIND, LEARN_BOOT_DELAY_MS, LEARN_INTERVAL_MS, METRIC_GRACE_HOURS, ProgrammeLearningService,
} from './programme-learning.service';
import { NETWORK_DEFAULTS } from './engine/reward.util';

const WS = 'ws-1';
const PROG = 'prog-1';
const NOW = new Date('2026-09-20T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

function programme(over: Record<string, unknown> = {}) {
  return {
    id: PROG, workspaceId: WS, name: 'P', status: 'ACTIVE', killSwitch: false, goal: 'COMPOSITE',
    socialCampaignId: 'camp-1', maturityHours: 72, halfLifeDays: 30, seedWeeks: 2, phase: 'SEED',
    lastReweightedAt: null as Date | null, lastMeasuredAt: null as Date | null, createdAt: daysAgo(3), ...over,
  } as any;
}
function slot(over: Record<string, unknown> = {}) {
  return {
    id: 'slot-1', workspaceId: WS, programmeId: PROG, status: 'READY', contentTypeId: 'id-how-to', contentTypeKey: 'how-to',
    scheduledFor: daysAgo(4), campaignItemId: 'item-1', socialPostId: null, publishedAt: null, measuredAt: null,
    reward: null, rewardBreakdown: null, ...over,
  };
}
const type = (key: string, over: Record<string, unknown> = {}) =>
  ({ id: `id-${key}`, workspaceId: WS, key, active: true, minShare: 0.05, maxShare: 0.4, ordinal: 0, ...over });
const metric = (over: Record<string, unknown> = {}) => ({
  impressions: 0, reach: 0, engagements: 0, likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, videoViews: 0, leads: 0, date: daysAgo(1), ...over,
});

function harness() {
  const prisma: any = {
    contentSlot: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    socialCampaignItem: { findFirst: jest.fn().mockResolvedValue(null) },
    socialPost: { findFirst: jest.fn().mockResolvedValue(null) },
    socialPostTarget: { findMany: jest.fn().mockResolvedValue([]) },
    socialPostMetric: { findMany: jest.fn().mockResolvedValue([]) },
    contentType: { findMany: jest.fn().mockResolvedValue([]) },
    contentTypeStat: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    contentProgramme: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    contentProgrammeEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const svc = new ProgrammeLearningService(prisma, scheduledJobs as any, runner as any);
  return { svc, prisma, scheduledJobs, runner };
}
const events = (prisma: any) => prisma.contentProgrammeEvent.create.mock.calls.map((c: any[]) => c[0].data);
const slotWrites = (prisma: any) => prisma.contentSlot.updateMany.mock.calls.map((c: any[]) => c[0]);

describe('ProgrammeLearningService.settle', () => {
  it('marks a READY slot PUBLISHED once its campaign item\'s post went out, taking the post\'s publishedAt and id', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([slot()]);
    prisma.socialCampaignItem.findFirst.mockResolvedValue({ id: 'item-1', socialPostId: 'post-1', status: 'PUBLISHED' });
    const publishedAt = hoursAgo(5);
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'post-1', status: 'PUBLISHED', publishedAt, updatedAt: hoursAgo(4), targets: [{ status: 'PUBLISHED' }] });

    const n = await svc.settle(WS, programme());

    expect(n).toBe(1);
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, programmeId: PROG, status: 'READY' }) }));
    expect(prisma.socialCampaignItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item-1', workspaceId: WS } }));
    expect(prisma.socialPost.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'post-1', workspaceId: WS } }));
    expect(slotWrites(prisma)).toEqual([{
      where: { id: 'slot-1', workspaceId: WS, status: 'READY' },
      data: { status: 'PUBLISHED', publishedAt, socialPostId: 'post-1' },
    }]);
  });

  it('leaves a slot whose post is still on its way, and fails one whose post failed (with an event)', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([slot({ id: 'pending', socialPostId: 'post-p' }), slot({ id: 'broken', socialPostId: 'post-f' })]);
    prisma.socialPost.findFirst
      .mockResolvedValueOnce({ id: 'post-p', status: 'SCHEDULED', publishedAt: null, targets: [] })
      .mockResolvedValueOnce({ id: 'post-f', status: 'FAILED', publishedAt: null, targets: [{ status: 'FAILED', error: 'token expired' }] });

    const n = await svc.settle(WS, programme());

    expect(n).toBe(0);
    expect(slotWrites(prisma)).toEqual([{
      where: { id: 'broken', workspaceId: WS, status: 'READY' },
      data: { status: 'FAILED', error: expect.stringContaining('token expired') },
    }]);
    expect(events(prisma)).toEqual([expect.objectContaining({ workspaceId: WS, programmeId: PROG, kind: 'SLOT_FAILED', data: expect.objectContaining({ slotId: 'broken' }) })]);
  });

  it('a partially published post (one target out, one failed) still counts as published, dated by updatedAt when publishedAt is missing', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([slot({ socialPostId: 'post-1', campaignItemId: null })]);
    const updatedAt = hoursAgo(2);
    prisma.socialPost.findFirst.mockResolvedValue({ id: 'post-1', status: 'PUBLISHING', publishedAt: null, updatedAt, targets: [{ status: 'PUBLISHED' }, { status: 'FAILED' }] });
    await svc.settle(WS, programme());
    expect(slotWrites(prisma)[0].data).toEqual({ status: 'PUBLISHED', publishedAt: updatedAt, socialPostId: 'post-1' });
  });
});

describe('ProgrammeLearningService.measureDue', () => {
  const published = (over: Record<string, unknown> = {}) =>
    slot({ id: 'slot-m', status: 'PUBLISHED', socialPostId: 'post-1', publishedAt: hoursAgo(80), ...over });

  it('measures only slots past maturity, scoring every published target against its account\'s 30-day baseline', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([published()]);
    prisma.socialPostTarget.findMany.mockResolvedValue([
      { id: 't-ig', socialAccountId: 'acc-ig', network: 'INSTAGRAM', status: 'PUBLISHED', metrics: [metric({ impressions: 1000, engagements: 60, saves: 5, shares: 5 })] },
      { id: 't-tt', socialAccountId: 'acc-tt', network: 'TIKTOK', status: 'PUBLISHED', metrics: [metric({ videoViews: 2000, likes: 100, comments: 10, shares: 10 })] },
    ]);
    // IG account history: median engagement 0.03, save-share 0.005, views 1000 → this post is exactly 2× on engagement.
    prisma.socialPostMetric.findMany.mockImplementation(async ({ where }: any) =>
      where.target.socialAccountId === 'acc-ig'
        ? [metric({ impressions: 1000, engagements: 10, saves: 2, shares: 3 }), metric({ impressions: 1000, engagements: 30, saves: 3, shares: 2 }), metric({ impressions: 1000, engagements: 50, saves: 5, shares: 5 })]
        : []);

    const n = await svc.measureDue(WS, programme(), NOW);

    expect(n).toBe(1);
    const q = prisma.contentSlot.findMany.mock.calls[0][0];
    expect(q.where).toEqual(expect.objectContaining({ workspaceId: WS, programmeId: PROG, status: 'PUBLISHED', publishedAt: { lte: hoursAgo(72) } }));
    expect(prisma.socialPostTarget.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, postId: 'post-1', status: 'PUBLISHED' }) }));
    // The baseline excludes the post being measured and looks 30 days back.
    const bq = prisma.socialPostMetric.findMany.mock.calls.find((c: any[]) => c[0].where.target.socialAccountId === 'acc-ig')[0];
    expect(bq.where).toEqual(expect.objectContaining({ workspaceId: WS, date: { gte: daysAgo(30) }, target: { socialAccountId: 'acc-ig', postId: { not: 'post-1' } } }));
    expect(bq.distinct).toEqual(['targetId']);

    const write = slotWrites(prisma)[0];
    expect(write.where).toEqual({ id: 'slot-m', workspaceId: WS, status: 'PUBLISHED' });
    expect(write.data.status).toBe('MEASURED');
    expect(write.data.measuredAt).toEqual(NOW);
    const ig = write.data.rewardBreakdown.INSTAGRAM;
    const tt = write.data.rewardBreakdown.TIKTOK;
    expect(ig.baselineSource).toBe('account');
    expect(ig.engagementBaseline).toBeCloseTo(0.03, 9);
    expect(ig.engagementR).toBeCloseTo(1, 9); // 0.06 / (2 × 0.03)
    expect(ig.saveShareR).toBeCloseTo(1, 9); // 0.01 / (2 × 0.005)
    expect(ig.viewsR).toBeCloseTo(0.5, 9); // 1000 / (2 × 1000)
    expect(ig.reward).toBeCloseTo(0.5 * 1 + 0.3 * 1 + 0.2 * 0.5, 9);
    expect(tt.baselineSource).toBe('network-default');
    expect(tt.engagementBaseline).toBe(NETWORK_DEFAULTS.engagementRate);
    expect(tt.engagementR).toBeCloseTo(1, 9); // 0.06 / 0.06
    expect(tt.saveShareR).toBeCloseTo(0.5, 9); // 0.005 / 0.01
    expect(tt.viewsR).toBeCloseTo(1, 9); // 2000 / 1000
    expect(tt.reward).toBeCloseTo(0.5 + 0.15 + 0.2, 9);
    expect(write.data.reward).toBeCloseTo((ig.reward + tt.reward) / 2, 9);
    expect(prisma.contentProgramme.updateMany).toHaveBeenCalledWith({ where: { id: PROG, workspaceId: WS }, data: { lastMeasuredAt: NOW } });
    expect(events(prisma)).toEqual([expect.objectContaining({ kind: 'MEASURE', data: expect.objectContaining({ slotId: 'slot-m', contentTypeKey: 'how-to', reward: write.data.reward }) })]);
  });

  it('does not touch a slot that is not yet mature, and waits for metrics until the grace period ends', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([published({ id: 'young', publishedAt: hoursAgo(73) }), published({ id: 'old', publishedAt: hoursAgo(72 + METRIC_GRACE_HOURS + 1) })]);
    prisma.socialPostTarget.findMany.mockResolvedValue([{ id: 't', socialAccountId: 'acc', network: 'INSTAGRAM', status: 'PUBLISHED', metrics: [] }]);

    const n = await svc.measureDue(WS, programme(), NOW);

    expect(n).toBe(0);
    // 'young' has no metrics yet and is inside the grace window: left PUBLISHED for a later tick.
    // 'old' has waited long enough: closed as MEASURED with no reward so it never blocks the programme.
    expect(slotWrites(prisma)).toEqual([expect.objectContaining({
      where: { id: 'old', workspaceId: WS, status: 'PUBLISHED' },
      data: expect.objectContaining({ status: 'MEASURED', reward: null, error: expect.stringMatching(/no metrics/i) }),
    })]);
  });
});

describe('ProgrammeLearningService.measureDue — the metric row\'s clicks and a Reel\'s views reach the reward', () => {
  it('reads clicks off the metric row for a LEADS programme and scores a Reel (no impressions) on its views', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([slot({ id: 'slot-m', status: 'PUBLISHED', socialPostId: 'post-1', publishedAt: hoursAgo(80) })]);
    // A Reel row as the IG mapper writes it: views → videoViews, impressions 0, 20 link clicks, no leads.
    prisma.socialPostTarget.findMany.mockResolvedValue([
      { id: 't-ig', socialAccountId: 'acc-ig', network: 'INSTAGRAM', status: 'PUBLISHED', metrics: [metric({ videoViews: 1000, engagements: 60, clicks: 20 })] },
    ]);
    await svc.measureDue(WS, programme({ goal: 'LEADS' }), NOW);
    const ig = slotWrites(prisma)[0].data.rewardBreakdown.INSTAGRAM;
    expect(ig).toEqual(expect.objectContaining({ clicks: 20, leads: 0, denominator: 1000, leadSource: 'clicks', leadRate: 0.02, leadBaseline: 0.01, reward: 1 }));
  });
});

describe('ProgrammeLearningService.reweight', () => {
  const measured = (id: string, key: string, reward: number, perNetwork: Record<string, number>, measuredAt = hoursAgo(10)) =>
    slot({
      id, status: 'MEASURED', contentTypeKey: key, contentTypeId: `id-${key}`, reward, measuredAt,
      rewardBreakdown: Object.fromEntries(Object.entries(perNetwork).map(([n, r]) => [n, { reward: r }])),
    });
  const TYPES = [type('how-to', { ordinal: 0 }), type('pov-ugc', { ordinal: 1 }), type('listicle', { ordinal: 2, active: false })];

  it('is not due while nothing was ever measured, nor within 7 days of the last reweight', async () => {
    const a = harness();
    expect(await a.svc.reweight(WS, programme(), NOW)).toBeNull();
    expect(a.prisma.contentSlot.count).toHaveBeenCalledWith({ where: { workspaceId: WS, programmeId: PROG, status: 'MEASURED', reward: { not: null } } });
    const b = harness();
    b.prisma.contentSlot.count.mockResolvedValue(5);
    expect(await b.svc.reweight(WS, programme({ lastReweightedAt: daysAgo(3) }), NOW)).toBeNull();
    expect(a.prisma.contentTypeStat.createMany).not.toHaveBeenCalled();
    expect(b.prisma.contentTypeStat.createMany).not.toHaveBeenCalled();
    expect(b.prisma.contentSlot.findMany).not.toHaveBeenCalled();
  });

  it('folds every new measurement into the posterior per (type, network) and ALL, writes the stat rows, weights and the event', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.count.mockResolvedValue(3);
    prisma.contentType.findMany.mockResolvedValue(TYPES);
    prisma.contentSlot.findMany.mockResolvedValue([
      measured('s1', 'how-to', 0.8, { INSTAGRAM: 0.8 }),
      measured('s2', 'how-to', 0.6, { INSTAGRAM: 0.4, TIKTOK: 0.8 }),
      measured('s3', 'pov-ugc', 0.2, { INSTAGRAM: 0.2 }),
    ]);

    const res = await svc.reweight(WS, programme(), NOW);

    expect(res).not.toBeNull();
    expect(prisma.contentType.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, active: true } }));
    // First reweight: every measured slot with a reward, no lower time bound.
    expect(prisma.contentSlot.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, programmeId: PROG, status: 'MEASURED', reward: { not: null } });

    const rows = prisma.contentTypeStat.createMany.mock.calls[0][0].data as any[];
    const row = (key: string, network: string) => rows.find((r) => r.contentTypeKey === key && r.network === network);
    // Active types × (ALL + every network seen) — the inactive type gets no row.
    expect(rows).toHaveLength(2 * 3);
    expect(rows.every((r) => r.workspaceId === WS && r.programmeId === PROG && r.computedAt === NOW)).toBe(true);
    expect(rows.some((r) => r.contentTypeKey === 'listicle')).toBe(false);
    expect(row('how-to', 'ALL')).toEqual(expect.objectContaining({ contentTypeId: 'id-how-to', samples: 2, alpha: 1 + 0.8 + 0.6, beta: 1 + 0.2 + 0.4 }));
    expect(row('how-to', 'ALL').meanReward).toBeCloseTo(2.4 / 4, 9);
    expect(row('how-to', 'INSTAGRAM')).toEqual(expect.objectContaining({ samples: 2, alpha: 1 + 0.8 + 0.4, beta: 1 + 0.2 + 0.6 }));
    expect(row('how-to', 'TIKTOK')).toEqual(expect.objectContaining({ samples: 1, alpha: 1.8, beta: 1.2 }));
    expect(row('pov-ugc', 'TIKTOK')).toEqual(expect.objectContaining({ samples: 0, alpha: 1, beta: 1 }));
    expect(row('pov-ugc', 'ALL')).toEqual(expect.objectContaining({ samples: 1, alpha: 1.2, beta: 1.8 }));
    // Weights: two active types capped at 0.4 cannot fill a calendar (Σ max
    // 0.8), so the bounds are infeasible — the weights are the plain means
    // (0.6 / 0.4) and the reweight says so instead of charting 0.4 + 0.4.
    expect(row('how-to', 'ALL').weight).toBeCloseTo(0.6, 9);
    expect(row('pov-ugc', 'ALL').weight).toBeCloseTo(0.4, 9);

    expect(prisma.contentProgramme.updateMany).toHaveBeenCalledWith({ where: { id: PROG, workspaceId: WS }, data: { phase: 'SEED', lastReweightedAt: NOW } });
    expect(res).toEqual(expect.objectContaining({ phase: 'SEED', previousPhase: 'SEED', folded: 3, sharesFeasible: false, weights: { 'how-to': expect.any(Number), 'pov-ugc': expect.any(Number) } }));
    const ev = events(prisma).find((e: any) => e.kind === 'REWEIGHT');
    expect(ev).toEqual(expect.objectContaining({ workspaceId: WS, programmeId: PROG, message: expect.stringMatching(/how-to/) }));
    expect(ev.message).toMatch(/share bounds infeasible: floors sum to 0\.1, caps to 0\.8/);
    expect(ev.data).toEqual(expect.objectContaining({ folded: 3, phase: 'SEED', sharesFeasible: false, minShareSum: 0.1, maxShareSum: 0.8, weights: expect.any(Object), arms: expect.arrayContaining([expect.objectContaining({ key: 'how-to', samples: 2 })]) }));
  });

  it('with feasible bounds the weights are clipped to the caps, sum to 1, and the event carries no warning', async () => {
    const { svc, prisma } = harness();
    prisma.contentSlot.count.mockResolvedValue(1);
    prisma.contentType.findMany.mockResolvedValue([type('how-to', { ordinal: 0, maxShare: 0.5 }), type('pov-ugc', { ordinal: 1, maxShare: 0.6 })]);
    prisma.contentSlot.findMany.mockResolvedValue([measured('s1', 'how-to', 1, { INSTAGRAM: 1 })]);
    const res = await svc.reweight(WS, programme(), NOW);
    // Means 2/3 and 1/2 → 0.571 / 0.429 unclipped; how-to is pinned at 0.5 and pov-ugc takes the rest.
    expect(res!.sharesFeasible).toBe(true);
    expect(res!.weights['how-to']).toBeCloseTo(0.5, 9);
    expect(res!.weights['pov-ugc']).toBeCloseTo(0.5, 9);
    const ev = events(prisma).find((e: any) => e.kind === 'REWEIGHT');
    expect(ev.message).not.toMatch(/infeasible/);
    expect(ev.data).toEqual(expect.objectContaining({ sharesFeasible: true }));
  });

  it('EXPLOIT is held by the type that led the PREVIOUS reweight, so a younger leader cannot flap the phase', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findMany.mockResolvedValue([type('how-to', { ordinal: 0, maxShare: 1 }), type('pov-ugc', { ordinal: 1, maxShare: 1 })]);
    // how-to led last week on 5 samples (mean 0.6); pov-ugc sits at 0.5 on 48 samples with a tight sd.
    // The old symmetric exit saw how-to's wide lower bound under 0.5 and dropped to LEARN every week.
    prisma.contentTypeStat.findMany.mockResolvedValue([
      { contentTypeKey: 'how-to', contentTypeId: 'id-how-to', network: 'ALL', alpha: 4.2, beta: 2.8, samples: 5, computedAt: daysAgo(7) },
      { contentTypeKey: 'pov-ugc', contentTypeId: 'id-pov-ugc', network: 'ALL', alpha: 25, beta: 25, samples: 48, computedAt: daysAgo(7) },
    ]);
    const held = await svc.reweight(WS, programme({ phase: 'EXPLOIT', lastReweightedAt: daysAgo(7), createdAt: daysAgo(60), halfLifeDays: 0 }), NOW);
    expect(held!.phase).toBe('EXPLOIT');
    expect(events(prisma).find((e: any) => e.kind === 'REWEIGHT').data).toEqual(expect.objectContaining({ leaderKey: 'how-to' }));
    expect(events(prisma).some((e: any) => e.kind === 'PHASE')).toBe(false);

    // The week how-to is actually overtaken (two flops fold in, mean 0.46 < 0.5): back to LEARN.
    const b = harness();
    b.prisma.contentType.findMany.mockResolvedValue([type('how-to', { ordinal: 0, maxShare: 1 }), type('pov-ugc', { ordinal: 1, maxShare: 1 })]);
    b.prisma.contentTypeStat.findMany.mockResolvedValue([
      { contentTypeKey: 'how-to', contentTypeId: 'id-how-to', network: 'ALL', alpha: 4.2, beta: 2.8, samples: 5, computedAt: daysAgo(7) },
      { contentTypeKey: 'pov-ugc', contentTypeId: 'id-pov-ugc', network: 'ALL', alpha: 25, beta: 25, samples: 48, computedAt: daysAgo(7) },
    ]);
    b.prisma.contentSlot.findMany.mockResolvedValue([measured('f1', 'how-to', 0, { INSTAGRAM: 0 }), measured('f2', 'how-to', 0, { INSTAGRAM: 0 })]);
    const lost = await b.svc.reweight(WS, programme({ phase: 'EXPLOIT', lastReweightedAt: daysAgo(7), createdAt: daysAgo(60), halfLifeDays: 0 }), NOW);
    expect(lost!.phase).toBe('LEARN');
    expect(events(b.prisma).find((e: any) => e.kind === 'PHASE').data).toEqual(expect.objectContaining({ from: 'EXPLOIT', to: 'LEARN' }));
  });

  it('decays the previous posterior by the elapsed time before folding, only reads slots since the last reweight, and moves the phase', async () => {
    const { svc, prisma } = harness();
    const last = daysAgo(8);
    prisma.contentType.findMany.mockResolvedValue(TYPES.slice(0, 2));
    // Previous ALL stat for how-to computed 30 days ago (one half-life): evidence 8/4 → 4/2.
    prisma.contentTypeStat.findMany.mockResolvedValue([
      { contentTypeKey: 'how-to', contentTypeId: 'id-how-to', network: 'ALL', alpha: 9, beta: 5, samples: 6, computedAt: daysAgo(30) },
      { contentTypeKey: 'pov-ugc', contentTypeId: 'id-pov-ugc', network: 'ALL', alpha: 4, beta: 4, samples: 6, computedAt: daysAgo(30) },
    ]);
    prisma.contentSlot.findMany.mockResolvedValue([measured('s9', 'how-to', 1, { INSTAGRAM: 1 })]);

    const res = await svc.reweight(WS, programme({ phase: 'SEED', lastReweightedAt: last, createdAt: daysAgo(20) }), NOW);

    expect(prisma.contentSlot.count).not.toHaveBeenCalled();
    expect(prisma.contentSlot.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ measuredAt: { gt: last } }));
    expect(prisma.contentTypeStat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, programmeId: PROG }, distinct: ['contentTypeKey', 'network'] }));
    const rows = prisma.contentTypeStat.createMany.mock.calls[0][0].data as any[];
    const howAll = rows.find((r) => r.contentTypeKey === 'how-to' && r.network === 'ALL');
    expect(howAll.alpha).toBeCloseTo(5 + 1, 9);
    expect(howAll.beta).toBeCloseTo(3 + 0, 9);
    expect(howAll.samples).toBe(7);
    const povAll = rows.find((r) => r.contentTypeKey === 'pov-ugc' && r.network === 'ALL');
    expect(povAll).toEqual(expect.objectContaining({ alpha: 2.5, beta: 2.5, samples: 6 }));
    // 20 days in with seedWeeks 2 → the seed weeks elapsed → LEARN, with its own PHASE event.
    expect(res!.phase).toBe('LEARN');
    expect(prisma.contentProgramme.updateMany).toHaveBeenCalledWith({ where: { id: PROG, workspaceId: WS }, data: { phase: 'LEARN', lastReweightedAt: NOW } });
    expect(events(prisma).map((e: any) => e.kind).sort()).toEqual(['PHASE', 'REWEIGHT']);
    expect(events(prisma).find((e: any) => e.kind === 'PHASE').data).toEqual(expect.objectContaining({ from: 'SEED', to: 'LEARN' }));
  });

  it('SEED ends early once every active type has three measurements, even with nothing else new', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findMany.mockResolvedValue(TYPES.slice(0, 2));
    prisma.contentTypeStat.findMany.mockResolvedValue([
      { contentTypeKey: 'how-to', contentTypeId: 'id-how-to', network: 'ALL', alpha: 3, beta: 2, samples: 3, computedAt: daysAgo(7) },
      { contentTypeKey: 'pov-ugc', contentTypeId: 'id-pov-ugc', network: 'ALL', alpha: 2, beta: 3, samples: 3, computedAt: daysAgo(7) },
    ]);
    const res = await svc.reweight(WS, programme({ lastReweightedAt: daysAgo(7), createdAt: daysAgo(7) }), NOW);
    expect(res!.phase).toBe('LEARN');
  });
});

describe('ProgrammeLearningService.currentArms', () => {
  it('builds one arm per active type from its latest ALL stat, defaulting a never-measured type to Beta(1, 1)', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findMany.mockResolvedValue([type('how-to', { ordinal: 1, minShare: 0.1, maxShare: 0.3 }), type('pov-ugc', { ordinal: 2 })]);
    prisma.contentTypeStat.findMany.mockResolvedValue([
      { contentTypeKey: 'how-to', network: 'ALL', alpha: 4.2, beta: 1.8, samples: 5, computedAt: daysAgo(1) },
      { contentTypeKey: 'how-to', network: 'INSTAGRAM', alpha: 9, beta: 9, samples: 9, computedAt: daysAgo(1) },
      { contentTypeKey: 'gone', network: 'ALL', alpha: 9, beta: 9, samples: 9, computedAt: daysAgo(1) },
    ]);
    const arms = await svc.currentArms(WS, PROG);
    expect(prisma.contentType.findMany).toHaveBeenCalledWith({ where: { workspaceId: WS, active: true }, orderBy: { ordinal: 'asc' } });
    expect(prisma.contentTypeStat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, programmeId: PROG, network: 'ALL' } }));
    expect(arms).toEqual([
      { typeId: 'id-how-to', key: 'how-to', minShare: 0.1, maxShare: 0.3, alpha: 4.2, beta: 1.8, samples: 5, active: true },
      { typeId: 'id-pov-ugc', key: 'pov-ugc', minShare: 0.05, maxShare: 0.4, alpha: 1, beta: 1, samples: 0, active: true },
    ]);
  });
});

describe('ProgrammeLearningService job', () => {
  it('registers the 6-hourly learn job under the system workspace with a dedup key, first due a minute after boot', () => {
    const { svc, scheduledJobs, runner } = harness();
    const before = Date.now();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(CONTENT_PROGRAMME_LEARN_KIND, expect.any(Function));
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'system', kind: CONTENT_PROGRAMME_LEARN_KIND, dedupKey: 'content-programme-learn' }));
    // schedule() moves the existing PENDING row's runAt, so a boot must not
    // push the sweep a full interval out — deploys closer than 6h apart would
    // never let it become due. A minute after boot, and the handler takes it
    // from there.
    const runAt: Date = scheduledJobs.schedule.mock.calls[0][0].runAt;
    expect(runAt.getTime()).toBeGreaterThanOrEqual(before + LEARN_BOOT_DELAY_MS);
    expect(runAt.getTime()).toBeLessThan(before + LEARN_BOOT_DELAY_MS + 5_000);
    expect(LEARN_BOOT_DELAY_MS).toBe(60_000);
    expect(LEARN_INTERVAL_MS).toBe(6 * 3600_000);
  });

  /**
   * A published piece is out in front of people whatever happened to the
   * programme afterwards: settle and measure walk PAUSED and KILLED programmes
   * too, or a kill that caught a READY slot mid-publish would pin it READY
   * forever. Only the reweight is the running programme's.
   */
  it('runs settle → measure for EVERY programme and reweight only for an ACTIVE one, logs a failing programme and carries on, then reschedules', async () => {
    const { svc, prisma, runner } = harness();
    prisma.contentProgramme.findMany.mockResolvedValue([
      programme({ id: 'p-bad', workspaceId: 'ws-bad' }),
      programme({ id: 'p-ok' }),
      programme({ id: 'p-paused', status: 'PAUSED' }),
      programme({ id: 'p-killed', status: 'KILLED', killSwitch: true }),
    ]);
    const calls: string[] = [];
    jest.spyOn(svc, 'settle').mockImplementation(async (_ws, p: any) => { calls.push(`settle:${p.id}`); if (p.id === 'p-bad') throw new Error('boom'); return 0; });
    jest.spyOn(svc, 'measureDue').mockImplementation(async (_ws, p: any) => { calls.push(`measure:${p.id}`); return 0; });
    jest.spyOn(svc, 'reweight').mockImplementation(async (_ws, p: any) => { calls.push(`reweight:${p.id}`); return null; });
    svc.onModuleInit();
    const handler = runner.registerHandler.mock.calls[0][1];

    const before = Date.now();
    const res = await handler({ id: 'j', workspaceId: 'system', kind: CONTENT_PROGRAMME_LEARN_KIND, payload: {}, attempts: 0 });

    expect(prisma.contentProgramme.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: ['ACTIVE', 'PAUSED', 'KILLED'] } } }));
    expect(calls).toEqual([
      'settle:p-bad',
      'settle:p-ok', 'measure:p-ok', 'reweight:p-ok',
      'settle:p-paused', 'measure:p-paused',
      'settle:p-killed', 'measure:p-killed',
    ]);
    expect(events(prisma)).toEqual([expect.objectContaining({ workspaceId: 'ws-bad', programmeId: 'p-bad', kind: 'LEARN_ERROR', message: expect.stringContaining('boom') })]);
    expect(res.reschedule.runAt.getTime()).toBeGreaterThanOrEqual(before + LEARN_INTERVAL_MS);
  });
});
