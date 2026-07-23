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
  const orchestrator = { applyPlan: jest.fn().mockResolvedValue({ lane: 'ASSISTED', applied: 0, skipped: 0 }) };
  const svc = new StrategySynthesisService(prisma as any, anthropic as any, credits as any, runs as any, sources as any, spend as any, orchestrator as any);
  return { svc, complete, credits, runs, sources, spend, prisma, orchestrator };
}

describe('StrategySynthesisService', () => {
  it('still synthesizes a strategy when research sources are unconfigured (AI-only)', async () => {
    // firecrawl/apify off — the strategist must NOT be offered research tools, but
    // it MUST still produce a strategy from the intake auto-analysis + interview.
    const { svc, complete, credits, prisma } = deps({
      enabled: false,
      completions: [
        completion([toolUse('t2', 'submit_strategy', { archetype: 'B2C_COMMUNITY_NICHE', brief: GOOD_BRIEF, actions: GOOD_ACTIONS })]),
      ],
    });
    const r = await svc.synthesize('ws1', 'sess1');
    expect(r).toEqual({ strategyId: 'strat1', actionCount: 2 });
    expect(credits.reserve).toHaveBeenCalledWith('ws1', 8);
    expect(prisma.marketingStrategy.upsert).toHaveBeenCalled();
    // No research tools offered when sources are off — only submit_strategy.
    const toolNames = (complete.mock.calls[0][0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toEqual(['submit_strategy']);
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

  it('hands the freshly-seeded plan to the orchestrator (autonomy lane hook)', async () => {
    const { svc, orchestrator } = deps({
      completions: [
        completion([toolUse('t2', 'submit_strategy', { archetype: 'B2C_COMMUNITY_NICHE', brief: GOOD_BRIEF, actions: GOOD_ACTIONS })]),
      ],
    });
    await svc.synthesize('ws1', 'sess1');
    expect(orchestrator.applyPlan).toHaveBeenCalledWith('ws1');
  });

  it('B2C acceptance: classifies a community-niche business + writes communities into channels/pillars + emits COMMUNITY_ENGAGE actions (PROPOSED)', async () => {
    const B2C_BRIEF = {
      identity: { product: 'Private Metin2 server', voice: 'playful, nostalgic', positioning: 'The classic-era server', usp: 'Pre-2010 mechanics, no pay-to-win' },
      audience: 'Nostalgic Metin2 veterans, 20-35, EU',
      channels: [
        { key: 'reddit', fitScore: 0.9, rationale: 'r/Metin2 is where nostalgic players gather' },
        { key: 'discord', fitScore: 0.85, rationale: 'The "Metin2 Classic EU" Discord server hosts the active raid community' },
      ],
      contentPillars: [
        { title: 'Nostalgia memes', angle: 'classic-era in-jokes', formats: ['meme', 'image'], tone: 'playful meme humor' },
        { title: 'Boss-run tutorials', angle: 'how classic mechanics worked', formats: ['clip', 'guide'], tone: 'helpful community insider' },
      ],
      goals: { objective: 'Grow active players to 2k', kpis: ['DAU', 'Discord joins'] },
      budget: 'Bootstrap: organic community + $200/mo ads',
      competitors: ['OtherServer.gg'],
    };
    const B2C_ACTIONS = [
      { kind: 'COMMUNITY_ENGAGE', title: 'Drop a classic-era meme in r/Metin2', rationale: 'Where the audience is', priority: 'HIGH', payload: { channelKey: 'reddit', community: 'r/Metin2', title: 'Remember grinding at the spider dungeon?', angle: 'nostalgia', tone: 'playful', format: 'meme' } },
      { kind: 'COMMUNITY_ENGAGE', title: 'Share a boss-run tutorial in the Discord', rationale: 'Helpful native content builds trust', priority: 'MEDIUM', payload: { channelKey: 'discord', community: 'Metin2 Classic EU', title: 'Classic Meley strategy', angle: 'tutorial', tone: 'insider', format: 'tutorial' } },
    ];
    const { svc, complete, credits, prisma } = deps({
      completions: [
        completion([toolUse('t1', 'search_web', { query: 'metin2 private server community reddit discord' })]),
        completion([toolUse('t2', 'submit_strategy', { archetype: 'B2C_COMMUNITY_NICHE', brief: B2C_BRIEF, actions: B2C_ACTIONS })]),
      ],
    });
    const r = await svc.synthesize('ws1', 'sess1');

    expect(credits.reserve).toHaveBeenCalledWith('ws1', 8);
    const upsert = prisma.marketingStrategy.upsert.mock.calls[0][0];
    expect(upsert.create.archetype).toBe('B2C_COMMUNITY_NICHE');
    // Communities are written into the brief's channels WITH the specific community in the rationale.
    const persistedChannels = upsert.create.brief.channels;
    expect(persistedChannels.map((c: any) => c.key)).toEqual(expect.arrayContaining(['reddit', 'discord']));
    expect(persistedChannels.find((c: any) => c.key === 'reddit').rationale).toMatch(/r\/Metin2/);
    expect(persistedChannels.find((c: any) => c.key === 'discord').rationale).toMatch(/Discord/i);
    // Channel-native content pillars with a meme/community tone.
    expect(upsert.create.brief.contentPillars.some((p: any) => /meme/i.test(p.tone) || p.formats.includes('meme'))).toBe(true);
    // COMMUNITY_ENGAGE actions inserted PROPOSED, carrying the executor-ready community payload.
    const inserted = prisma.strategyAction.createMany.mock.calls[0][0].data;
    expect(inserted).toHaveLength(2);
    expect(inserted.every((a: any) => a.kind === 'COMMUNITY_ENGAGE' && a.status === 'PROPOSED')).toBe(true);
    expect(inserted[0].payload).toMatchObject({ channelKey: 'reddit', community: 'r/Metin2', format: 'meme' });
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
