import {
  ANOMALY_FAIL_STREAK,
  CONTENT_PROGRAMME_PLAN_KIND,
  CONTENT_SLOT_PLAN_KIND,
  CONTENT_SLOT_PRODUCE_KIND,
  PLAN_INTERVAL_MS,
  ProgrammePlannerService,
  composeIdea,
  istanbulWeekBounds,
  slotPlanDedup,
  slotProduceDedup,
  trendLine,
} from './programme-planner.service';

const WS = 'ws-1';
const PROG = 'prog-1';
const CAMP = 'camp-1';
/** A Wednesday, 12:00 UTC (15:00 Istanbul). */
const NOW = new Date('2026-09-16T12:00:00Z');
const H = 60 * 60 * 1000;
const D = 24 * H;
const at = (iso: string) => new Date(iso);

function programme(over: Record<string, unknown> = {}) {
  return {
    id: PROG, workspaceId: WS, name: 'P', status: 'ACTIVE', socialCampaignId: CAMP, goal: 'COMPOSITE',
    brief: 'Figurunica 3D baskı figürleri', personaId: null, perWeek: 5, weeklyCreditCap: 600, explorationRate: 0.15,
    maturityHours: 72, halfLifeDays: 30, editWindowHours: 2, lookaheadDays: 14, planLeadHours: 36, produceLeadHours: 12,
    seedWeeks: 2, phase: 'SEED', killSwitch: false, lastPlannedAt: null, lastMeasuredAt: null, lastReweightedAt: null,
    createdById: 'u-1', createdAt: at('2026-09-01T00:00:00Z'), updatedAt: at('2026-09-01T00:00:00Z'), ...over,
  } as any;
}
const type = (key: string, over: Record<string, unknown> = {}) => ({
  id: `id-${key}`, workspaceId: WS, key, name: `Name ${key}`, description: `Desc ${key}`,
  structure: [{ role: 'hook', durationSec: 3, guidance: 'Kanca' }, { role: 'body', durationSec: 12, guidance: 'Gövde' }],
  defaultDurationSec: 15, networks: [], minShare: 0.05, maxShare: 0.4, active: true, isSeed: true, ordinal: 0, ...over,
});
const arm = (key: string, over: Record<string, unknown> = {}) =>
  ({ typeId: `id-${key}`, key, minShare: 0.05, maxShare: 0.4, alpha: 1, beta: 1, samples: 0, active: true, ...over });
const slotRow = (over: Record<string, unknown> = {}) => ({
  id: 'slot-1', workspaceId: WS, programmeId: PROG, scheduledFor: at('2026-09-16T18:00:00Z'), status: 'PLANNED',
  contentTypeId: 'id-how-to', contentTypeKey: 'how-to', selectionReason: 'seed', trendSignalId: null, trendTitle: null,
  idea: 'x', conceptId: null, campaignItemId: null, socialPostId: null, quotedCredits: null, editableUntil: at('2026-09-16T16:00:00Z'),
  error: null, ...over,
});

function harness(over: { types?: unknown[]; arms?: unknown[]; upcoming?: unknown[]; last?: unknown; campaign?: unknown } = {}) {
  const upcoming = over.upcoming ?? [];
  const prisma: any = {
    contentProgramme: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialCampaign: {
      findFirst: jest.fn().mockResolvedValue(
        over.campaign === undefined
          ? { cadence: { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '18:00', timezone: 'Europe/Istanbul' }, targetAccountIds: ['acc-1', 'acc-2'] }
          : over.campaign,
      ),
    },
    contentSlot: {
      findMany: jest.fn().mockResolvedValue(upcoming),
      findFirst: jest.fn().mockResolvedValue(over.last ?? null),
      count: jest.fn().mockResolvedValue((upcoming as unknown[]).length),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: `slot-${data.scheduledFor.toISOString()}`, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialAccount: {
      findMany: jest.fn().mockResolvedValue([{ network: 'INSTAGRAM' }, { network: 'TIKTOK' }]),
    },
    brandProfile: {
      findFirst: jest.fn().mockResolvedValue({ brandName: 'Figurunica', tagline: 'Masaüstü figürler', description: 'Anime ve oyun figürleri' }),
    },
    socialCampaignItem: { findMany: jest.fn().mockResolvedValue([]) },
    contentProgrammeEvent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1'), cancel: jest.fn().mockResolvedValue(true) };
  const runner = { registerHandler: jest.fn() };
  const programmes = { logEvent: jest.fn().mockResolvedValue(undefined), pause: jest.fn().mockResolvedValue(programme({ status: 'PAUSED' })) };
  const types = { list: jest.fn().mockResolvedValue(over.types ?? [type('how-to'), type('pov-ugc'), type('listicle')]) };
  const learning = { currentArms: jest.fn().mockResolvedValue(over.arms ?? [arm('how-to'), arm('pov-ugc'), arm('listicle')]) };
  const trends = { top: jest.fn().mockResolvedValue([]) };
  const svc = new ProgrammePlannerService(prisma, scheduledJobs as any, runner as any, programmes as any, types as any, learning as any, trends as any);
  svc.rng = () => 0.9; // no exploration, no trend coin
  return { svc, prisma, scheduledJobs, runner, programmes, types, learning, trends };
}
const created = (prisma: any) => prisma.contentSlot.create.mock.calls.map((c: any[]) => c[0].data);
const scheduled = (jobs: any) => jobs.schedule.mock.calls.map((c: any[]) => c[0]);
const events = (programmes: any) => programmes.logEvent.mock.calls.map((c: any[]) => ({ kind: c[2], message: c[3], data: c[4] }));

describe('istanbulWeekBounds', () => {
  it('starts the week on Monday 00:00 Europe/Istanbul (21:00 UTC the Sunday before)', () => {
    expect(istanbulWeekBounds(NOW)).toEqual({ weekStart: at('2026-09-13T21:00:00Z'), weekEnd: at('2026-09-20T21:00:00Z') });
  });
  it('rolls at local midnight, not UTC midnight', () => {
    // Sunday 23:30 Istanbul is still the old week; Monday 01:00 Istanbul is the new one.
    expect(istanbulWeekBounds(at('2026-09-13T20:30:00Z')).weekStart).toEqual(at('2026-09-06T21:00:00Z'));
    expect(istanbulWeekBounds(at('2026-09-13T22:00:00Z')).weekStart).toEqual(at('2026-09-13T21:00:00Z'));
  });
});

describe('composeIdea', () => {
  it('is the type, its beats, the brief and (when present) the trend line — with no model call', () => {
    const idea = composeIdea(type('how-to'), 'Figurunica figürleri', { title: 'Dubai chocolate', network: 'TIKTOK', kind: 'TOPIC' });
    expect(idea).toContain('Name how-to: Desc how-to');
    expect(idea).toContain('beat 1 (0-3s): hook — Kanca');
    expect(idea).toContain("Program brief'i: Figurunica figürleri");
    expect(idea).toContain(trendLine({ title: 'Dubai chocolate', network: 'TIKTOK', kind: 'TOPIC' }));
    expect(idea).toContain('kopyalama, markaya uyarla');
    expect(composeIdea(type('how-to'), 'b', null)).not.toContain('Trend kancası');
  });
});

describe('ProgrammePlannerService.fill', () => {
  it('opens a PLANNED slot at every weekday cadence time inside the look-ahead, with the edit window and both jobs', async () => {
    const { svc, prisma, scheduledJobs, programmes } = harness();
    const out = await svc.fill(WS, programme(), NOW);

    // Wed 16 … Wed 30 12:00 horizon: 16,17,18, 21–25, 28,29 = 10 weekday 18:00 slots (30th 18:00 is past the horizon).
    expect(out.created).toBe(10);
    const rows = created(prisma);
    expect(rows[0]).toMatchObject({
      workspaceId: WS, programmeId: PROG, status: 'PLANNED', scheduledFor: at('2026-09-16T18:00:00Z'),
      editableUntil: at('2026-09-16T16:00:00Z'), contentTypeId: 'id-how-to', contentTypeKey: 'how-to',
    });
    expect(rows[0].selectionReason).toMatch(/seed round-robin/);
    expect(rows[9].scheduledFor).toEqual(at('2026-09-29T18:00:00Z'));
    // SEED walks the types round-robin, never repeating the previous slot's type.
    expect(rows.slice(0, 4).map((r: any) => r.contentTypeKey)).toEqual(['how-to', 'pov-ugc', 'listicle', 'how-to']);
    expect(rows.every((r: any) => r.idea.includes("Program brief'i: Figurunica"))).toBe(true);

    const jobs = scheduled(scheduledJobs);
    expect(jobs).toHaveLength(20);
    expect(jobs.filter((j: any) => j.kind === CONTENT_SLOT_PLAN_KIND)).toHaveLength(10);
    expect(jobs.filter((j: any) => j.kind === CONTENT_SLOT_PRODUCE_KIND)).toHaveLength(10);
    expect(jobs[0]).toMatchObject({ workspaceId: WS, dedupKey: slotPlanDedup('slot-2026-09-16T18:00:00.000Z'), payload: { workspaceId: WS, programmeId: PROG } });
    expect(jobs[1].dedupKey).toBe(slotProduceDedup('slot-2026-09-16T18:00:00.000Z'));

    expect(prisma.contentProgramme.updateMany).toHaveBeenCalledWith({ where: { id: PROG, workspaceId: WS }, data: { lastPlannedAt: NOW } });
    const ev = events(programmes).find((e) => e.kind === 'SLOT_PLANNED');
    expect(ev.data).toMatchObject({ created: 10, mix: { 'how-to': 4, 'pov-ugc': 3, listicle: 3 } });
    expect(programmes.logEvent).toHaveBeenCalledTimes(1);
  });

  it('clamps a job whose lead time is already past to now, so a slot inside its window is planned at once', async () => {
    const { svc, scheduledJobs } = harness();
    await svc.fill(WS, programme(), NOW);
    const jobs = scheduled(scheduledJobs);
    // Wed 18:00: plan (−36h) and produce (−12h) are both in the past → now.
    expect(jobs[0].runAt).toEqual(NOW);
    expect(jobs[1].runAt).toEqual(NOW);
    // Thu 18:00: plan (Wed 06:00) → now; produce → Thu 06:00.
    expect(jobs[2].runAt).toEqual(NOW);
    expect(jobs[3].runAt).toEqual(at('2026-09-17T06:00:00Z'));
    // Fri 18:00: plan → Thu 06:00, produce → Fri 06:00.
    expect(jobs[4].runAt).toEqual(at('2026-09-17T06:00:00Z'));
    expect(jobs[5].runAt).toEqual(at('2026-09-18T06:00:00Z'));
  });

  it('skips times that already have a slot and walks on from the last planned one', async () => {
    const existing = slotRow({ id: 'have', scheduledFor: at('2026-09-16T18:00:00Z'), contentTypeKey: 'listicle' });
    const { svc, prisma } = harness({ upcoming: [existing], last: existing });
    prisma.contentSlot.count.mockResolvedValue(7);
    const out = await svc.fill(WS, programme(), NOW);
    expect(out.created).toBe(9);
    const rows = created(prisma);
    expect(rows[0].scheduledFor).toEqual(at('2026-09-17T18:00:00Z'));
    // The previous slot's type (listicle) is not repeated; the seed cursor continues from the count.
    expect(rows[0].contentTypeKey).not.toBe('listicle');
    expect(rows[0].selectionReason).toMatch(/cursor 7 of 3/);
  });

  it('treats a unique-constraint collision as "someone else planned that time" and carries on', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    prisma.contentSlot.create.mockRejectedValueOnce({ code: 'P2002' });
    const out = await svc.fill(WS, programme(), NOW);
    expect(out.created).toBe(9);
    expect(scheduled(scheduledJobs)).toHaveLength(18);
  });

  it('honours a type floor through the window counts: a starved type gets the slot before any sampling', async () => {
    const existing = ['a', 'b', 'c'].map((id) => slotRow({ id, scheduledFor: at(`2026-09-1${7 + ['a', 'b', 'c'].indexOf(id)}T18:00:00Z`), contentTypeKey: 'pov-ugc' }));
    const { svc, prisma } = harness({
      types: [type('how-to', { minShare: 0.5, maxShare: 1 }), type('pov-ugc', { maxShare: 1 })],
      arms: [arm('how-to', { minShare: 0.5, maxShare: 1, alpha: 1, beta: 9 }), arm('pov-ugc', { maxShare: 1, alpha: 9, beta: 1 })],
      upcoming: existing,
      last: existing[2],
    });
    await svc.fill(WS, programme({ phase: 'LEARN', explorationRate: 0.05, lookaheadDays: 7 }), NOW);
    const rows = created(prisma);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].contentTypeKey).toBe('how-to');
    expect(rows[0].selectionReason).toMatch(/^floor: how-to/);
  });

  it('attaches the top on-brand trend to a trend-remix slot and writes the hook into the idea', async () => {
    const { svc, prisma, trends } = harness({ types: [type('trend-remix')], arms: [arm('trend-remix')] });
    trends.top.mockResolvedValue([
      { signal: { id: 't-1', title: 'Figurunica figür challenge', network: 'TIKTOK', kind: 'HASHTAG' }, decayed: 0.8, relevance: 0.3, suggestion: 0.41 },
      { signal: { id: 't-2', title: 'other', network: 'TIKTOK', kind: 'TOPIC' }, decayed: 0.5, relevance: 0, suggestion: 0.15 },
    ]);
    await svc.fill(WS, programme({ lookaheadDays: 7 }), NOW);
    const rows = created(prisma);
    expect(rows[0]).toMatchObject({ trendSignalId: 't-1', trendTitle: 'Figurunica figür challenge' });
    expect(rows[0].idea).toContain('Trend kancası: Figurunica figür challenge (TIKTOK/HASHTAG) — kopyalama, markaya uyarla');
    // One trend read per fill, scoped to the campaign's networks and the brand's words.
    expect(trends.top).toHaveBeenCalledTimes(1);
    const opts = trends.top.mock.calls[0][1];
    expect(trends.top.mock.calls[0][0]).toBe('TR');
    expect(opts.networks).toEqual(['INSTAGRAM', 'TIKTOK']);
    expect(opts.brandKeywords).toEqual(expect.arrayContaining(['figurunica', 'figurler', 'baski']));
    expect(opts.limit).toBe(5);
    expect(prisma.socialAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, id: { in: ['acc-1', 'acc-2'] } }) }));
    expect(prisma.brandProfile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS } }));
  });

  it('leaves a slot without a trend when the best signal is too weak, and a non-remix type only takes one on the coin', async () => {
    const weak = harness({ types: [type('trend-remix')], arms: [arm('trend-remix')] });
    weak.trends.top.mockResolvedValue([{ signal: { id: 't-1', title: 'x', network: 'TIKTOK', kind: 'TOPIC' }, suggestion: 0.1 }]);
    await weak.svc.fill(WS, programme({ lookaheadDays: 7 }), NOW);
    expect(created(weak.prisma)[0].trendSignalId).toBeNull();

    const coin = harness({ types: [type('how-to')], arms: [arm('how-to')] });
    coin.svc.rng = () => 0.1; // < 0.25 → every slot draws a hook
    coin.trends.top.mockResolvedValue([{ signal: { id: 't-9', title: 'hot', network: 'INSTAGRAM', kind: 'SOUND' }, suggestion: 0.5 }]);
    await coin.svc.fill(WS, programme({ lookaheadDays: 7 }), NOW);
    expect(created(coin.prisma).every((r: any) => r.trendSignalId === 't-9')).toBe(true);
  });

  it('scopes every read to the workspace', async () => {
    const { svc, prisma, types, learning } = harness();
    await svc.fill(WS, programme(), NOW);
    expect(prisma.socialCampaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CAMP, workspaceId: WS } }));
    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, programmeId: PROG }) }));
    expect(prisma.contentSlot.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, programmeId: PROG } }));
    expect(prisma.contentSlot.count).toHaveBeenCalledWith({ where: { workspaceId: WS, programmeId: PROG } });
    expect(types.list).toHaveBeenCalledWith(WS, { activeOnly: true });
    expect(learning.currentArms).toHaveBeenCalledWith(WS, PROG);
  });
});

describe('ProgrammePlannerService.reconcile', () => {
  it('moves PRODUCING slots with their item: SCHEDULED/PUBLISHED → READY, FAILED → FAILED with the reason, SKIPPED → SKIPPED', async () => {
    const { svc, prisma, programmes } = harness();
    prisma.contentSlot.findMany.mockResolvedValue([
      slotRow({ id: 's-ok', status: 'PRODUCING', campaignItemId: 'i-ok' }),
      slotRow({ id: 's-pub', status: 'PRODUCING', campaignItemId: 'i-pub' }),
      slotRow({ id: 's-bad', status: 'PRODUCING', campaignItemId: 'i-bad' }),
      slotRow({ id: 's-skip', status: 'PRODUCING', campaignItemId: 'i-skip' }),
      slotRow({ id: 's-wait', status: 'PRODUCING', campaignItemId: 'i-wait' }),
    ]);
    prisma.socialCampaignItem.findMany.mockResolvedValue([
      { id: 'i-ok', status: 'SCHEDULED', error: null, socialPostId: 'post-1' },
      { id: 'i-pub', status: 'PUBLISHED', error: null, socialPostId: 'post-2' },
      { id: 'i-bad', status: 'FAILED', error: 'fal: out of credits', socialPostId: null },
      { id: 'i-skip', status: 'SKIPPED', error: null, socialPostId: null },
      { id: 'i-wait', status: 'GENERATING', error: null, socialPostId: null },
    ]);
    await svc.reconcile(WS, programme());

    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS, programmeId: PROG, status: 'PRODUCING', campaignItemId: { not: null } },
    }));
    expect(prisma.socialCampaignItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['i-ok', 'i-pub', 'i-bad', 'i-skip', 'i-wait'] }, workspaceId: WS },
    }));
    const writes = prisma.contentSlot.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(writes).toEqual([
      { where: { id: 's-ok', workspaceId: WS, status: 'PRODUCING' }, data: { status: 'READY', error: null, socialPostId: 'post-1' } },
      { where: { id: 's-pub', workspaceId: WS, status: 'PRODUCING' }, data: { status: 'READY', error: null, socialPostId: 'post-2' } },
      { where: { id: 's-bad', workspaceId: WS, status: 'PRODUCING' }, data: { status: 'FAILED', error: 'fal: out of credits' } },
      { where: { id: 's-skip', workspaceId: WS, status: 'PRODUCING' }, data: { status: 'SKIPPED', error: 'campaign item skipped' } },
    ]);
    expect(events(programmes).map((e) => e.kind)).toEqual(['SLOT_READY', 'SLOT_READY', 'SLOT_FAILED', 'SLOT_SKIPPED']);
  });
});

describe('ProgrammePlannerService.checkAnomalies', () => {
  it('pauses the programme after three FAILED slots in a row, once per streak', async () => {
    const { svc, prisma, programmes } = harness();
    const failed = ['f1', 'f2', 'f3'].map((id) => slotRow({ id, status: 'FAILED', error: `boom ${id}` }));
    prisma.contentSlot.findMany.mockResolvedValueOnce(failed);
    await svc.checkAnomalies(WS, programme(), NOW);

    expect(prisma.contentSlot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS, programmeId: PROG, status: { not: 'PLANNED' } }, take: ANOMALY_FAIL_STREAK,
    }));
    expect(programmes.pause).toHaveBeenCalledWith(WS, PROG);
    const ev = events(programmes).find((e) => e.kind === 'ANOMALY_PAUSE');
    expect(ev.message).toMatch(/3 slots failed in a row: boom f1; boom f2; boom f3/);
    expect(ev.data).toMatchObject({ reason: 'fail-streak', slotIds: ['f1', 'f2', 'f3'] });

    // The same three after a resume: already reported, not paused again.
    programmes.pause.mockClear();
    prisma.contentSlot.findMany.mockResolvedValueOnce(failed).mockResolvedValueOnce([]);
    prisma.contentProgrammeEvent.findFirst.mockResolvedValue({ data: { slotIds: ['f1', 'f2', 'f3'] } });
    await svc.checkAnomalies(WS, programme(), NOW);
    expect(programmes.pause).not.toHaveBeenCalled();
  });

  it('pauses when this Istanbul week\'s committed credits pass 120% of the cap', async () => {
    const { svc, prisma, programmes } = harness();
    prisma.contentSlot.findMany
      .mockResolvedValueOnce([slotRow({ status: 'READY' })]) // streak check: not three failures
      .mockResolvedValueOnce([{ id: 'a', quotedCredits: 400 }, { id: 'b', quotedCredits: 350 }, { id: 'c', quotedCredits: null }]);
    await svc.checkAnomalies(WS, programme({ weeklyCreditCap: 600 }), NOW);

    expect(prisma.contentSlot.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        workspaceId: WS, programmeId: PROG, status: { in: ['IDEATED', 'PRODUCING', 'READY', 'PUBLISHED', 'MEASURED'] },
        scheduledFor: { gte: at('2026-09-13T21:00:00Z'), lt: at('2026-09-20T21:00:00Z') },
      },
    }));
    expect(programmes.pause).toHaveBeenCalledWith(WS, PROG);
    const ev = events(programmes).find((e) => e.kind === 'ANOMALY_PAUSE');
    expect(ev.data).toMatchObject({ reason: 'spend', spent: 750, cap: 600, limit: 720 });
  });

  it('does nothing at 120% exactly or below', async () => {
    const { svc, prisma, programmes } = harness();
    prisma.contentSlot.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'a', quotedCredits: 720 }]);
    await svc.checkAnomalies(WS, programme({ weeklyCreditCap: 600 }), NOW);
    expect(programmes.pause).not.toHaveBeenCalled();
  });
});

describe('ProgrammePlannerService job', () => {
  it('registers the 6-hourly sweep under the system workspace with its dedup key', () => {
    const { svc, runner, scheduledJobs } = harness();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(CONTENT_PROGRAMME_PLAN_KIND, expect.any(Function));
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'system', kind: CONTENT_PROGRAMME_PLAN_KIND, dedupKey: 'content-programme-plan',
    }));
  });

  it('runs reconcile → fill → anomaly per live programme, logs a failing one as PLAN_ERROR, carries on, and reschedules', async () => {
    const { svc, prisma, runner, programmes } = harness();
    prisma.contentProgramme.findMany.mockResolvedValue([programme({ id: 'p-bad', socialCampaignId: 'gone' }), programme({ id: 'p-ok' })]);
    prisma.socialCampaign.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cadence: { daysOfWeek: [3], timeOfDay: '18:00' }, targetAccountIds: [] });
    svc.onModuleInit();
    const handler = runner.registerHandler.mock.calls[0][1];
    const before = Date.now();
    const res = await handler({ id: 'j', workspaceId: 'system', kind: CONTENT_PROGRAMME_PLAN_KIND, payload: {}, attempts: 0 });

    expect(prisma.contentProgramme.findMany).toHaveBeenCalledWith({ where: { status: 'ACTIVE', killSwitch: false } });
    const errs = events(programmes).filter((e) => e.kind === 'PLAN_ERROR');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/campaign gone is gone/);
    expect(programmes.logEvent.mock.calls[0][1]).toBe('p-bad');
    expect(events(programmes).some((e) => e.kind === 'SLOT_PLANNED')).toBe(true);
    expect(res.reschedule.runAt.getTime()).toBeGreaterThanOrEqual(before + PLAN_INTERVAL_MS - 1000);
  });
});
