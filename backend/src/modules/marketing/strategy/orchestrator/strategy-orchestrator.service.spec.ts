import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StrategyOrchestrator } from './strategy-orchestrator.service';
import { SKIP_KILL_SWITCH, SKIP_NO_EXECUTOR, SKIP_RUN_CAP } from './skip-reasons';

const action = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  workspaceId: 'ws1',
  strategyId: 'strat1',
  kind: 'CONTENT',
  status: 'APPROVED',
  priority: 'MEDIUM',
  // Real rows always carry these (the submit schema requires them), and the
  // dispatch forwards them to the executor as the payload-title fallback.
  title: 'Weekly clips series',
  rationale: 'Proof content converts best',
  payload: { title: 'Weekly clips' },
  ...over,
});

function deps(overrides: { action?: any; leadRun?: any; contentRun?: any; communityRun?: any; adRun?: any } = {}) {
  const prisma = {
    strategyAction: {
      findFirst: jest.fn().mockResolvedValue(overrides.action === undefined ? action() : overrides.action),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => ({ ...action(), id: where.id, ...data })),
    },
  };
  const leadHunt = {
    kind: 'LEAD_HUNT' as const,
    run: jest.fn().mockResolvedValue(overrides.leadRun ?? { resultRef: 'research:run1' }),
  };
  const content = {
    kind: 'CONTENT' as const,
    run: jest.fn().mockResolvedValue(overrides.contentRun ?? { resultRef: 'post:post1' }),
  };
  const communityEngage = {
    kind: 'COMMUNITY_ENGAGE' as const,
    run: jest.fn().mockResolvedValue(overrides.communityRun ?? { resultRef: 'community:post1' }),
  };
  const adCampaign = {
    kind: 'AD_CAMPAIGN' as const,
    run: jest.fn().mockResolvedValue(overrides.adRun ?? { resultRef: 'campaign:camp1' }),
  };
  const svc = new StrategyOrchestrator(prisma as any, leadHunt as any, content as any, communityEngage as any, adCampaign as any);
  return { svc, prisma, leadHunt, content, communityEngage, adCampaign };
}

/**
 * applyPlan deps: an id-aware prisma so `execute` (re-reads the action by id) and
 * `applyPlan` (findMany PROPOSED + update) both see a consistent action store.
 */
function applyDeps(cfg: { strategy?: any; actions?: any[]; killSwitch?: boolean; contentRun?: any } = {}) {
  const store: Record<string, any> = {};
  for (const a of cfg.actions ?? []) store[a.id] = { ...a };
  const strategy = cfg.strategy === undefined ? { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'AUTONOMOUS' } : cfg.strategy;
  const prisma = {
    marketingStrategy: { findUnique: jest.fn().mockResolvedValue(strategy) },
    strategyAction: {
      findMany: jest.fn().mockImplementation(async () => Object.values(store).filter((a) => a.status === 'PROPOSED')),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => store[where.id] ?? null),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        store[where.id] = { ...store[where.id], ...data };
        return store[where.id];
      }),
      // Honours the `where` on purpose: a conditional claim that a mock always
      // reports as successful is a claim no test can tell from a plain write.
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const row = store[where.id];
        if (!row) return { count: 0 };
        if (where.status !== undefined && row.status !== where.status) return { count: 0 };
        store[where.id] = { ...row, ...data };
        return { count: 1 };
      }),
    },
  };
  const mk = (kind: string, ref: string | undefined) => ({ kind, run: jest.fn().mockResolvedValue({ resultRef: ref }) });
  const leadHunt = mk('LEAD_HUNT', 'research:run1');
  const content = cfg.contentRun === undefined
    ? mk('CONTENT', 'post:post1')
    : { kind: 'CONTENT', run: jest.fn(cfg.contentRun) };
  const communityEngage = mk('COMMUNITY_ENGAGE', 'community:post1');
  const adCampaign = mk('AD_CAMPAIGN', 'campaign:camp1');
  const svc = new StrategyOrchestrator(prisma as any, leadHunt as any, content as any, communityEngage as any, adCampaign as any);
  return { svc, prisma, store, leadHunt, content, communityEngage, adCampaign };
}

const proposed = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 'ws1', strategyId: 'strat1', kind, status: 'PROPOSED', priority: 'MEDIUM',
  title: `${kind} action`, rationale: 'why it matters', payload: {}, ...over,
});

afterEach(() => {
  delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
});

describe('StrategyOrchestrator', () => {
  it('dispatches to the executor for the action kind, sets RUNNING then DONE + resultRef', async () => {
    const { svc, prisma, content, leadHunt } = deps();
    const r = await svc.execute('ws1', 'a1');

    expect(content.run).toHaveBeenCalledWith('ws1', { title: 'Weekly clips' }, expect.objectContaining({ title: expect.any(String), rationale: expect.any(String) }));
    expect(leadHunt.run).not.toHaveBeenCalled();
    // RUNNING first, then DONE.
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(1, { where: { id: 'a1' }, data: { status: 'RUNNING' } });
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'DONE', resultRef: 'post:post1' },
    });
    expect(r).toEqual({ status: 'DONE', resultRef: 'post:post1' });
  });

  it('routes LEAD_HUNT actions to the lead-hunt executor', async () => {
    const { svc, leadHunt, content } = deps({ action: action({ kind: 'LEAD_HUNT', payload: { icpDescription: 'salons' } }) });
    await svc.execute('ws1', 'a1');
    expect(leadHunt.run).toHaveBeenCalledWith('ws1', { icpDescription: 'salons' }, expect.objectContaining({ title: expect.any(String), rationale: expect.any(String) }));
    expect(content.run).not.toHaveBeenCalled();
  });

  it('routes COMMUNITY_ENGAGE actions to the community-engage executor (DONE + community ref)', async () => {
    const { svc, prisma, communityEngage, content, leadHunt } = deps({
      action: action({ kind: 'COMMUNITY_ENGAGE', payload: { channelKey: 'reddit', community: 'r/Metin2', title: 'meme' } }),
    });
    const r = await svc.execute('ws1', 'a1');
    expect(communityEngage.run).toHaveBeenCalledWith('ws1', { channelKey: 'reddit', community: 'r/Metin2', title: 'meme' }, expect.objectContaining({ title: expect.any(String), rationale: expect.any(String) }));
    expect(content.run).not.toHaveBeenCalled();
    expect(leadHunt.run).not.toHaveBeenCalled();
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'DONE', resultRef: 'community:post1' },
    });
    expect(r).toEqual({ status: 'DONE', resultRef: 'community:post1' });
  });

  it('stores a null resultRef when the executor returns none', async () => {
    const { svc, prisma } = deps({ contentRun: { resultRef: undefined } });
    const r = await svc.execute('ws1', 'a1');
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'DONE', resultRef: null },
    });
    expect(r).toEqual({ status: 'DONE', resultRef: null });
  });

  it('marks the action FAILED (and records the error) when the executor throws, without crashing', async () => {
    const { svc, prisma, content } = deps();
    content.run.mockRejectedValue(new Error('kaboom'));
    const r = await svc.execute('ws1', 'a1');
    expect(r).toEqual({ status: 'FAILED', error: 'kaboom' });
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'FAILED', resultRef: 'error:kaboom' },
    });
  });

  it('routes AD_CAMPAIGN actions to the ad-campaign executor (DONE + campaign ref)', async () => {
    const { svc, prisma, adCampaign, content, leadHunt } = deps({
      action: action({ kind: 'AD_CAMPAIGN', payload: { objective: 'leads' } }),
    });
    const r = await svc.execute('ws1', 'a1');
    expect(adCampaign.run).toHaveBeenCalledWith('ws1', { objective: 'leads' }, expect.objectContaining({ title: expect.any(String), rationale: expect.any(String) }));
    expect(content.run).not.toHaveBeenCalled();
    expect(leadHunt.run).not.toHaveBeenCalled();
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'DONE', resultRef: 'campaign:camp1' },
    });
    expect(r).toEqual({ status: 'DONE', resultRef: 'campaign:camp1' });
  });

  it('no-ops (skipped) for a not-yet-supported kind, leaving it APPROVED', async () => {
    const { svc, prisma, leadHunt, content } = deps({ action: action({ kind: 'CHANNEL_SETUP' }) });
    const r = await svc.execute('ws1', 'a1');
    expect(r).toEqual({ skipped: 'executor-not-available' });
    expect(leadHunt.run).not.toHaveBeenCalled();
    expect(content.run).not.toHaveBeenCalled();
    // The STATUS is still untouched — that is what "leaving it APPROVED"
    // means. The only write is the reason it is parked, which is the
    // difference between an action nobody has got to and one that has nowhere
    // to go; see the no-executor cases at the bottom of this file.
    for (const call of prisma.strategyAction.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('status');
    }
  });

  it('guards non-APPROVED actions (BadRequest), without dispatching', async () => {
    const { svc, content } = deps({ action: action({ status: 'PROPOSED' }) });
    await expect(svc.execute('ws1', 'a1')).rejects.toThrow(BadRequestException);
    expect(content.run).not.toHaveBeenCalled();
  });

  it('throws NotFound for a missing/other-workspace action', async () => {
    const { svc } = deps({ action: null });
    await expect(svc.execute('ws1', 'nope')).rejects.toThrow(NotFoundException);
  });
});

describe('StrategyOrchestrator.applyPlan (autonomy lanes)', () => {
  it('does nothing when the workspace has no strategy', async () => {
    const { svc, prisma } = applyDeps({ strategy: null });
    const r = await svc.applyPlan('ws1');
    expect(r).toEqual({ lane: 'NONE', applied: 0, attempted: 0, noResult: 0, failed: 0, noExecutor: 0, skipped: 0, skippedReasons: {} });
    expect(prisma.strategyAction.findMany).not.toHaveBeenCalled();
  });

  it('SHADOW leaves all PROPOSED (observation only)', async () => {
    const { svc, prisma, store } = applyDeps({
      strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'SHADOW' },
      actions: [proposed('a1', 'CONTENT'), proposed('a2', 'LEAD_HUNT')],
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ lane: 'SHADOW', applied: 0 });
    expect(prisma.strategyAction.update).not.toHaveBeenCalled();
    expect(store.a1.status).toBe('PROPOSED');
    expect(store.a2.status).toBe('PROPOSED');
  });

  it('ASSISTED leaves all PROPOSED (execution stays approval-gated)', async () => {
    const { svc, prisma } = applyDeps({
      strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'ASSISTED' },
      actions: [proposed('a1', 'CONTENT')],
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ lane: 'ASSISTED', applied: 0 });
    expect(prisma.strategyAction.update).not.toHaveBeenCalled();
  });

  it('AUTONOMOUS + kill-switch ON executes each PROPOSED action (flip APPROVED → dispatch)', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc, store, content, adCampaign, communityEngage } = applyDeps({
      actions: [proposed('a1', 'CONTENT', { payload: { title: 't' } }), proposed('a2', 'AD_CAMPAIGN', { payload: { objective: 'leads' } }), proposed('a3', 'COMMUNITY_ENGAGE')],
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ lane: 'AUTONOMOUS', applied: 3, skipped: 0 });
    expect(content.run).toHaveBeenCalledWith('ws1', { title: 't' }, expect.objectContaining({ title: expect.any(String), rationale: expect.any(String) }));
    expect(adCampaign.run).toHaveBeenCalledWith('ws1', { objective: 'leads' }, expect.objectContaining({ title: expect.any(String), rationale: expect.any(String) }));
    expect(communityEngage.run).toHaveBeenCalled();
    expect(store.a1.status).toBe('DONE');
    expect(store.a2.status).toBe('DONE');
    expect(store.a3.status).toBe('DONE');
  });

  it('AUTONOMOUS + kill-switch OFF does NOT execute spend/publish actions, but runs read-only LEAD_HUNT', async () => {
    delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
    const { svc, store, content, adCampaign, communityEngage, leadHunt } = applyDeps({
      actions: [proposed('a1', 'CONTENT'), proposed('a2', 'AD_CAMPAIGN'), proposed('a3', 'COMMUNITY_ENGAGE'), proposed('a4', 'LEAD_HUNT', { payload: { icpDescription: 'salons' } })],
    });
    const r = await svc.applyPlan('ws1');
    // Only the read-only LEAD_HUNT auto-runs; the 3 spend/publish kinds stay PROPOSED.
    expect(r).toMatchObject({ lane: 'AUTONOMOUS', applied: 1, skipped: 3 });
    expect(content.run).not.toHaveBeenCalled();
    expect(adCampaign.run).not.toHaveBeenCalled();
    expect(communityEngage.run).not.toHaveBeenCalled();
    expect(leadHunt.run).toHaveBeenCalledWith('ws1', { icpDescription: 'salons' }, expect.objectContaining({ title: expect.any(String), rationale: expect.any(String) }));
    expect(store.a1.status).toBe('PROPOSED');
    expect(store.a2.status).toBe('PROPOSED');
    expect(store.a3.status).toBe('PROPOSED');
    expect(store.a4.status).toBe('DONE');
  });

  it('respects the per-run cap (max 10 auto-applied)', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const actions = Array.from({ length: 13 }, (_, i) => proposed(`a${i}`, 'LEAD_HUNT', { payload: { icpDescription: 'x' }, createdAt: i }));
    const { svc, leadHunt } = applyDeps({ actions });
    const r = await svc.applyPlan('ws1');
    expect(r.applied).toBe(10);
    expect(leadHunt.run).toHaveBeenCalledTimes(10);
  });
});

/**
 * "Say why an action did NOT run."
 *
 * A PROPOSED action with a null resultRef is ambiguous in the worst possible
 * way: it reads identically whether the sweep declined it, never reached it, or
 * never ran at all. Every assertion below is about closing that gap, because
 * the daily brief's "what it did NOT do and why" has no other source.
 */
describe('StrategyOrchestrator.applyPlan (why an action did not run)', () => {
  it('stamps the kill-switch reason on each spend/publish action it leaves PROPOSED', async () => {
    delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
    const { svc, store } = applyDeps({
      actions: [proposed('a1', 'CONTENT'), proposed('a2', 'AD_CAMPAIGN')],
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ applied: 0, skipped: 2, skippedReasons: { [SKIP_KILL_SWITCH]: 2 } });
    // The status is untouched — the reason is additional information, not a
    // state change. An action that is waiting must still be waiting.
    expect(store.a1).toMatchObject({ status: 'PROPOSED', resultRef: SKIP_KILL_SWITCH });
    expect(store.a2).toMatchObject({ status: 'PROPOSED', resultRef: SKIP_KILL_SWITCH });
  });

  it('stamps the run-cap reason on the actions past MAX_AUTO_ACTIONS instead of walking away', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const actions = Array.from({ length: 12 }, (_, i) =>
      proposed(`a${i}`, 'LEAD_HUNT', { payload: { icpDescription: 'x' } }),
    );
    const { svc, store, leadHunt } = applyDeps({ actions });
    const r = await svc.applyPlan('ws1');
    // The cap itself is unchanged: exactly ten actions still execute.
    expect(leadHunt.run).toHaveBeenCalledTimes(10);
    expect(r).toMatchObject({ applied: 10, skipped: 2, skippedReasons: { [SKIP_RUN_CAP]: 2 } });
    expect(store.a10).toMatchObject({ status: 'PROPOSED', resultRef: SKIP_RUN_CAP });
    expect(store.a11).toMatchObject({ status: 'PROPOSED', resultRef: SKIP_RUN_CAP });
  });

  /**
   * The reason has to be the one the owner can act on.
   *
   * A kill-switched action never consumes an attempt, so testing the cap first
   * cannot change what RUNS - only what the row says. But `skipped:run-cap`
   * renders in the brief as "these will be handled on the next run", and for an
   * action the switch is blocking that is a promise the next run cannot keep:
   * the switch is still off, and it will be off tomorrow. The owner is told to
   * wait when the one thing that would unblock them is to arm the switch.
   */
  it('names the standing blocker, not the cap, when both would apply', async () => {
    delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
    const actions = [
      // Ten runnable actions spend the whole per-run cap first...
      ...Array.from({ length: 10 }, (_, i) =>
        proposed(`lh${i}`, 'LEAD_HUNT', { payload: { icpDescription: 'x' } }),
      ),
      // ...so this one is reached with `attempted` already at MAX_AUTO_ACTIONS,
      // AND it is a publish kind the kill-switch is holding.
      proposed('c1', 'CONTENT'),
    ];
    const { svc, store } = applyDeps({ actions });
    const r = await svc.applyPlan('ws1');
    expect(store.c1).toMatchObject({ status: 'PROPOSED', resultRef: SKIP_KILL_SWITCH });
    expect(r.skippedReasons).toMatchObject({ [SKIP_KILL_SWITCH]: 1 });
    expect(r.skippedReasons[SKIP_RUN_CAP]).toBeUndefined();
  });

  it('still stamps the cap on an action nothing else is blocking', async () => {
    // The swap must not swallow the cap reason for a kind the switch ignores.
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const actions = Array.from({ length: 11 }, (_, i) =>
      proposed(`lh${i}`, 'LEAD_HUNT', { payload: { icpDescription: 'x' } }),
    );
    const { svc, store } = applyDeps({ actions });
    const r = await svc.applyPlan('ws1');
    expect(store.lh10).toMatchObject({ status: 'PROPOSED', resultRef: SKIP_RUN_CAP });
    expect(r.skippedReasons).toEqual({ [SKIP_RUN_CAP]: 1 });
  });

  it('does NOT rewrite a reason that has not changed', async () => {
    // The cost control, and the reason this is a conditional write rather than
    // an unconditional one. Any write to a StrategyAction lifts its updatedAt
    // above strategy.updatedAt, which is exactly the predicate the weekly
    // feedback cron reads to decide a workspace is worth a fresh Opus
    // re-synthesis. On a DAILY tick, stamping the same "still blocked" reason
    // every morning would bill the most expensive action in the product, every
    // week, to re-learn nothing.
    delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
    const { svc, prisma } = applyDeps({
      actions: [proposed('a1', 'CONTENT', { resultRef: SKIP_KILL_SWITCH })],
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ skipped: 1, skippedReasons: { [SKIP_KILL_SWITCH]: 1 } });
    expect(prisma.strategyAction.update).not.toHaveBeenCalled();
  });

  it('writes when the reason CHANGES — a new cause is a new outcome', async () => {
    delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
    const { svc, prisma, store } = applyDeps({
      actions: [proposed('a1', 'CONTENT', { resultRef: SKIP_RUN_CAP })],
    });
    await svc.applyPlan('ws1');
    expect(prisma.strategyAction.update).toHaveBeenCalledTimes(1);
    expect(store.a1.resultRef).toBe(SKIP_KILL_SWITCH);
  });

  it('a failed stamp never costs the sweep an action it could run', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const actions = Array.from({ length: 11 }, (_, i) =>
      proposed(`a${i}`, 'LEAD_HUNT', { payload: { icpDescription: 'x' } }),
    );
    const { svc, prisma, leadHunt } = applyDeps({ actions });
    const realUpdate = prisma.strategyAction.update.getMockImplementation()!;
    prisma.strategyAction.update.mockImplementation(async (args: any) => {
      if (args.data?.resultRef === SKIP_RUN_CAP) throw new Error('db down');
      return realUpdate(args);
    });
    const r = await svc.applyPlan('ws1');
    expect(leadHunt.run).toHaveBeenCalledTimes(10);
    expect(r).toMatchObject({ applied: 10, skipped: 1 });
  });
});

describe('StrategyOrchestrator.execute (no executor for the kind)', () => {
  it('stamps the no-executor reason so a permanently parked action can be named', async () => {
    // CHANNEL_SETUP has no registered executor. Without a stamp it sits at
    // APPROVED forever, indistinguishable from an action still in the queue —
    // and applyPlan only ever re-reads PROPOSED rows, so nothing revisits it.
    const { svc, prisma } = deps({ action: action({ kind: 'CHANNEL_SETUP', status: 'APPROVED' }) });
    const r = await svc.execute('ws1', 'a1');
    expect(r).toEqual({ skipped: 'executor-not-available' });
    expect(prisma.strategyAction.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { resultRef: SKIP_NO_EXECUTOR },
    });
  });

  it('does not rewrite the no-executor reason it already carries', async () => {
    const { svc, prisma } = deps({
      action: action({ kind: 'CHANNEL_SETUP', status: 'APPROVED', resultRef: SKIP_NO_EXECUTOR }),
    });
    await svc.execute('ws1', 'a1');
    expect(prisma.strategyAction.update).not.toHaveBeenCalled();
  });
});

/**
 * "Can an action execute twice?"
 *
 * Until the daily driver shipped, `applyPlan` had exactly one caller — the tail
 * of a synthesis run, under an advisory lock. It now has two more that hold no
 * lock between them: the hourly tick, and `setAutonomy` on an HTTP request a
 * browser will happily fire twice. `execute` asserts the status it finds but
 * claims nothing, so without a conditional claim two sweeps both read PROPOSED,
 * both write APPROVED and both dispatch — and for COMMUNITY_ENGAGE with a
 * connected Discord/Reddit channel, "dispatch" means a live post to a real
 * community. Twice.
 */
describe('StrategyOrchestrator.applyPlan (an action is claimed, not just written)', () => {
  it('claims PROPOSED -> APPROVED conditionally, so a lost race dispatches nothing', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc, prisma, leadHunt } = applyDeps({
      actions: [proposed('a1', 'LEAD_HUNT', { payload: { icpDescription: 'x' } })],
    });
    // The other runner won between our findMany and our claim.
    prisma.strategyAction.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await svc.applyPlan('ws1');
    expect(leadHunt.run).not.toHaveBeenCalled();
    expect(r).toMatchObject({ applied: 0 });
  });

  it('two concurrent sweeps run each action exactly once', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc, leadHunt } = applyDeps({
      actions: [
        proposed('a1', 'LEAD_HUNT', { payload: { icpDescription: 'x' } }),
        proposed('a2', 'LEAD_HUNT', { payload: { icpDescription: 'y' } }),
      ],
    });
    // Both sweeps read the same PROPOSED rows before either has written.
    const [r1, r2] = await Promise.all([svc.applyPlan('ws1'), svc.applyPlan('ws1')]);
    expect(leadHunt.run).toHaveBeenCalledTimes(2);
    expect(r1.applied + r2.applied).toBe(2);
  });

  it('narrows the claim by the status it read, not by id alone', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc, prisma } = applyDeps({
      actions: [proposed('a1', 'LEAD_HUNT', { payload: { icpDescription: 'x' } })],
    });
    await svc.applyPlan('ws1');
    expect(prisma.strategyAction.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', status: 'PROPOSED' },
      data: { status: 'APPROVED' },
    });
  });
});

/**
 * "How many did it apply?"
 *
 * `applied` incremented after `execute()` returned, whatever it returned. That
 * counted the executor-not-available case, the FAILED case, and every
 * `resultRef: undefined` degradation — and three of the four executors degrade
 * on a common, real condition (no AI key, no connected ad account). The number
 * is not academic: `setAutonomy` hands it straight to the console at the exact
 * moment an owner arms autonomy, so "10 uygulandı" could be ten actions that
 * produced nothing at all. The daily brief already draws this line; the sweep
 * now draws the same one.
 */
describe('StrategyOrchestrator.applyPlan (what actually ran)', () => {
  it('does not count a degraded executor as applied — it counts it as noResult', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc } = applyDeps({
      actions: [proposed('a1', 'CONTENT')],
      // The real degradation: the composer has no AI key, so the executor
      // returns without producing a post. The action is still DONE.
      contentRun: async () => ({ resultRef: undefined }),
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ applied: 0, noResult: 1, attempted: 1, failed: 0, noExecutor: 0 });
  });

  it('does not count a FAILED action as applied', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc } = applyDeps({
      actions: [proposed('a1', 'CONTENT')],
      contentRun: async () => { throw new Error('kaboom'); },
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ applied: 0, failed: 1, attempted: 1 });
  });

  it('does not count an action with no executor as applied', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    // CHANNEL_SETUP has no registered executor: nothing ran at all.
    const { svc } = applyDeps({ actions: [proposed('a1', 'CHANNEL_SETUP')] });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ applied: 0, noExecutor: 1, attempted: 1 });
  });

  it('counts a real result as applied, and keeps attempted === the four outcomes', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc } = applyDeps({
      actions: [
        proposed('a1', 'LEAD_HUNT', { payload: { icpDescription: 'x' } }),
        proposed('a2', 'CONTENT'),
        proposed('a3', 'CHANNEL_SETUP'),
      ],
      contentRun: async () => ({ resultRef: undefined }),
    });
    const r = await svc.applyPlan('ws1');
    expect(r).toMatchObject({ applied: 1, noResult: 1, noExecutor: 1, failed: 0, attempted: 3 });
    expect(r.applied + r.noResult + r.failed + r.noExecutor).toBe(r.attempted);
  });

  it('caps on what it ATTEMPTED, not on what produced — a plan of degrading actions is still bounded', async () => {
    // The trap in making `applied` honest: the per-run cap reads that counter.
    // If it kept reading it, a plan of fifty actions whose executors all degrade
    // would dispatch all fifty — the blast radius the cap exists to bound,
    // opened by fixing the number next to it.
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const actions = Array.from({ length: 14 }, (_, i) => proposed(`a${i}`, 'CONTENT'));
    const { svc, content } = applyDeps({ actions, contentRun: async () => ({ resultRef: undefined }) });
    const r = await svc.applyPlan('ws1');
    expect(content.run).toHaveBeenCalledTimes(10);
    expect(r).toMatchObject({ attempted: 10, applied: 0, noResult: 10, skipped: 4 });
  });
});

