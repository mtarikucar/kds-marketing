import { NotFoundException } from '@nestjs/common';
import { StrategySynthesisService } from './strategy-synthesis.service';

const GOOD_BRIEF = {
  identity: { product: 'Private Metin2 server', voice: 'playful, nostalgic', positioning: 'The classic-era server', usp: 'Pre-2010 mechanics, no pay-to-win' },
  audience: 'Nostalgic Metin2 veterans, 20-35, EU',
  channels: [{ key: 'reddit', fitScore: 0.9, rationale: 'r/Metin2 is where they gather' }],
  contentPillars: [{ title: 'Classic-era clips', angle: 'nostalgia', formats: ['reel', 'meme'], tone: 'playful' }],
  goals: { objective: 'Grow active players to 2k', kpis: ['DAU', 'Discord joins'] },
  budget: 'Bootstrap: organic community + $200/mo ads',
  competitors: ['OtherServer.gg'],
};

const GOOD_ACTIONS = [
  { kind: 'COMMUNITY_ENGAGE', title: 'Post in r/Metin2', rationale: 'Where the audience is', payload: { subreddit: 'Metin2' }, priority: 'HIGH' },
  { kind: 'CONTENT', title: 'Weekly nostalgia clips', rationale: 'Resonates', payload: { pillar: 'Classic-era clips' } },
  { kind: 'bogus', title: 'drop me', rationale: 'invalid kind', payload: {} }, // filtered out
];

const toolUse = (id: string, name: string, input: unknown) => ({ id, name, input });
const completion = (toolUses: any[]) => ({ text: '', toolUses, stopReason: 'tool_use', usage: { input: 10, output: 10 } });

function deps(overrides: { enabled?: boolean; aiEnabled?: boolean; completions?: any[]; session?: any } = {}) {
  const complete = jest.fn();
  (overrides.completions ?? []).forEach((c) => complete.mockResolvedValueOnce(c));
  const anthropic = { isEnabled: () => overrides.aiEnabled ?? true, complete };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const runs = {
    track: jest.fn(async (_ws: string, _in: unknown, fn: (id: string) => Promise<unknown>) => fn('run1')),
    recordTool: jest.fn().mockResolvedValue(undefined),
  };
  const sources = {
    isEnabled: () => overrides.enabled ?? true,
    apify: { searchPlaces: jest.fn().mockResolvedValue([]), lookupInstagram: jest.fn(), isConfigured: () => true },
    firecrawl: { scrape: jest.fn(), searchWeb: jest.fn().mockResolvedValue([]), isConfigured: () => true },
  };
  const spend = { settle: jest.fn().mockResolvedValue(null) };
  const session = overrides.session === undefined ? { id: 'sess1', workspaceId: 'ws1', autoAnalysis: { product: 'Metin2 server' }, transcript: { qa: [{ questions: ['Budget?'], answers: ['$200/mo'] }] } } : overrides.session;
  const prisma = {
    strategyIntakeSession: {
      findFirst: jest.fn().mockResolvedValue(session),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    marketingStrategy: { upsert: jest.fn().mockResolvedValue({ id: 'strat1' }) },
    strategyAction: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 2 }) },
  };
  const svc = new StrategySynthesisService(prisma as any, anthropic as any, credits as any, runs as any, sources as any, spend as any);
  return { svc, complete, credits, runs, sources, spend, prisma };
}

describe('StrategySynthesisService', () => {
  it('skips when no source providers are configured', async () => {
    const { svc, credits } = deps({ enabled: false });
    expect(await svc.synthesize('ws1', 'sess1')).toEqual({ strategyId: null, actionCount: 0, skipped: 'sources-not-configured' });
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('skips when AI is not configured', async () => {
    const { svc } = deps({ aiEnabled: false });
    expect((await svc.synthesize('ws1', 'sess1')).skipped).toBe('ai-not-configured');
  });

  it('throws NotFound for an unknown session', async () => {
    const { svc } = deps({ session: null });
    await expect(svc.synthesize('ws1', 'nope')).rejects.toThrow(NotFoundException);
  });

  it('researches then upserts an ACTIVE strategy + inserts the ActionPlan, reserving credit', async () => {
    const { svc, complete, credits, prisma, spend } = deps({
      completions: [
        completion([toolUse('t1', 'search_web', { query: 'metin2 community' })]),
        completion([toolUse('t2', 'submit_strategy', { archetype: 'B2C_COMMUNITY_NICHE', brief: GOOD_BRIEF, actions: GOOD_ACTIONS })]),
      ],
    });
    const r = await svc.synthesize('ws1', 'sess1');

    expect(complete).toHaveBeenCalledTimes(2);
    expect(credits.reserve).toHaveBeenCalledWith('ws1', 8);
    expect(spend.settle).toHaveBeenCalled(); // the research tool metered

    const upsert = prisma.marketingStrategy.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ workspaceId: 'ws1' });
    expect(upsert.create.status).toBe('ACTIVE');
    expect(upsert.create.archetype).toBe('B2C_COMMUNITY_NICHE');
    expect(upsert.update.version).toEqual({ increment: 1 });

    const inserted = prisma.strategyAction.createMany.mock.calls[0][0].data;
    expect(inserted).toHaveLength(2); // bogus-kind action filtered out
    expect(inserted[0]).toMatchObject({ workspaceId: 'ws1', strategyId: 'strat1', kind: 'COMMUNITY_ENGAGE', priority: 'HIGH', status: 'PROPOSED' });
    expect(inserted[1].priority).toBe('MEDIUM'); // defaulted
    expect(r).toEqual({ strategyId: 'strat1', actionCount: 2 });
  });

  it('rejects + refunds + does NOT upsert on an invalid brief', async () => {
    const badBrief = { ...GOOD_BRIEF, channels: [] }; // channels min(1) violated
    const { svc, credits, prisma } = deps({
      completions: [completion([toolUse('t2', 'submit_strategy', { archetype: 'B2C_ECOMMERCE', brief: badBrief, actions: [] })])],
    });
    await expect(svc.synthesize('ws1', 'sess1')).rejects.toThrow(/invalid strategy brief/);
    expect(credits.refund).toHaveBeenCalledWith('ws1', 8);
    expect(prisma.marketingStrategy.upsert).not.toHaveBeenCalled();
  });

  it('refunds if the AI loop throws', async () => {
    const { svc, credits, complete } = deps({ completions: [] });
    complete.mockRejectedValueOnce(new Error('anthropic down'));
    await expect(svc.synthesize('ws1', 'sess1')).rejects.toThrow('anthropic down');
    expect(credits.refund).toHaveBeenCalledWith('ws1', 8);
  });

  it('caps the tool-loop and refunds when no strategy is ever submitted', async () => {
    // Model keeps calling research tools, never submits — the iteration cap ends it.
    const forever = completion([toolUse('t', 'search_web', { query: 'x' })]);
    const { svc, credits, prisma, complete } = deps({ completions: Array.from({ length: 20 }, () => forever) });
    await expect(svc.synthesize('ws1', 'sess1')).rejects.toThrow(/no strategy/);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(10); // MAX_ITERS
    expect(prisma.marketingStrategy.upsert).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledWith('ws1', 8);
  });
});
