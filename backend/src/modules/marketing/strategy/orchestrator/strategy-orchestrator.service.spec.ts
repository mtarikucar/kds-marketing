import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StrategyOrchestrator } from './strategy-orchestrator.service';

const action = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  workspaceId: 'ws1',
  strategyId: 'strat1',
  kind: 'CONTENT',
  status: 'APPROVED',
  priority: 'MEDIUM',
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
function applyDeps(cfg: { strategy?: any; actions?: any[]; killSwitch?: boolean } = {}) {
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
    },
  };
  const mk = (kind: string, ref: string) => ({ kind, run: jest.fn().mockResolvedValue({ resultRef: ref }) });
  const leadHunt = mk('LEAD_HUNT', 'research:run1');
  const content = mk('CONTENT', 'post:post1');
  const communityEngage = mk('COMMUNITY_ENGAGE', 'community:post1');
  const adCampaign = mk('AD_CAMPAIGN', 'campaign:camp1');
  const svc = new StrategyOrchestrator(prisma as any, leadHunt as any, content as any, communityEngage as any, adCampaign as any);
  return { svc, prisma, store, leadHunt, content, communityEngage, adCampaign };
}

const proposed = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 'ws1', strategyId: 'strat1', kind, status: 'PROPOSED', priority: 'MEDIUM', payload: {}, ...over,
});

afterEach(() => {
  delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
});

describe('StrategyOrchestrator', () => {
  it('dispatches to the executor for the action kind, sets RUNNING then DONE + resultRef', async () => {
    const { svc, prisma, content, leadHunt } = deps();
    const r = await svc.execute('ws1', 'a1');

    expect(content.run).toHaveBeenCalledWith('ws1', { title: 'Weekly clips' });
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
    expect(leadHunt.run).toHaveBeenCalledWith('ws1', { icpDescription: 'salons' });
    expect(content.run).not.toHaveBeenCalled();
  });

  it('routes COMMUNITY_ENGAGE actions to the community-engage executor (DONE + community ref)', async () => {
    const { svc, prisma, communityEngage, content, leadHunt } = deps({
      action: action({ kind: 'COMMUNITY_ENGAGE', payload: { channelKey: 'reddit', community: 'r/Metin2', title: 'meme' } }),
    });
    const r = await svc.execute('ws1', 'a1');
    expect(communityEngage.run).toHaveBeenCalledWith('ws1', { channelKey: 'reddit', community: 'r/Metin2', title: 'meme' });
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
    expect(adCampaign.run).toHaveBeenCalledWith('ws1', { objective: 'leads' });
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
    expect(prisma.strategyAction.update).not.toHaveBeenCalled();
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
    expect(r).toEqual({ lane: 'NONE', applied: 0, skipped: 0 });
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
    expect(content.run).toHaveBeenCalledWith('ws1', { title: 't' });
    expect(adCampaign.run).toHaveBeenCalledWith('ws1', { objective: 'leads' });
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
    expect(leadHunt.run).toHaveBeenCalledWith('ws1', { icpDescription: 'salons' });
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
