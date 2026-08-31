import { McpToolRegistry } from '../mcp-tool-registry';
import { registerResearchTools, ResearchToolDeps } from './research.tools';

function build(features: Record<string, boolean> = { research: true }) {
  const research = {
    list: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Istanbul restaurants' }]),
    create: jest.fn().mockResolvedValue({ id: 'p1', status: 'ACTIVE' }),
    update: jest.fn().mockResolvedValue({ id: 'p1', status: 'PAUSED' }),
    usage: jest.fn().mockResolvedValue({ used: 3, limit: 10, remaining: 7 }),
  };
  const runner = { enqueueNow: jest.fn().mockResolvedValue(undefined) };
  const candidates = {
    list: jest.fn().mockResolvedValue([{ id: 'c1', businessName: 'HTC Events', score: 0.72 }]),
    accept: jest.fn().mockResolvedValue({ accepted: 1, ingest: { created: 1 } }),
    reject: jest.fn().mockResolvedValue({ rejected: 1 }),
  };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features }) };
  const registry = new McpToolRegistry();
  registerResearchTools(registry, { research, runner, candidates, entitlements } as unknown as ResearchToolDeps);
  return { registry, research, runner, candidates, entitlements };
}

const CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };
const ALL = ['settings.manage'];
const VALID_ICP =
  'Independent restaurants in Istanbul with 2 to 10 branches that still take phone orders on paper and have no POS integration.';

describe('Faz 5 D4 — research/prospecting MCP tools', () => {
  it('registers exactly the research tools in the research domain', () => {
    const { registry } = build();
    const tools = registry.list([...ALL, 'leads.write']);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'jeeta.list_research_profiles',
        'jeeta.pause_research_profile',
        'jeeta.create_research_profile',
        'jeeta.run_research',
        'jeeta.list_research_candidates',
        'jeeta.accept_research_candidates',
        'jeeta.reject_research_candidates',
        // The MCP lane: the owner's own Claude drains the nightly queue.
        'jeeta.claim_research_job',
        'jeeta.submit_research_candidates',
        'jeeta.complete_research_job',
        'jeeta.research_search_places',
        'jeeta.research_lookup_instagram',
        'jeeta.research_scrape_page',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.domain).toBe('research');
      // Configuring and reading the hunt is `settings.manage`; the two tools
      // that decide whether a prospect becomes a LEAD are `leads.write`, so a
      // settings-only grant cannot mint CRM rows through the research door.
      const expected = /accept_research_candidates|reject_research_candidates/.test(t.name)
        ? ['leads.write']
        : ['settings.manage'];
      expect(t.scopes).toEqual(expected);
    }
  });

  it('gates every tool on the research module', async () => {
    const { registry } = build({});
    const calls: Array<[string, Record<string, unknown>]> = [
      ['jeeta.list_research_profiles', {}],
      ['jeeta.create_research_profile', { name: 'n', icpDescription: VALID_ICP }],
      ['jeeta.run_research', { profileId: 'p1' }],
    ];
    for (const [name, args] of calls) {
      await expect(registry.get(name)!.handler(CTX, args)).rejects.toMatchObject({
        response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'research' },
      });
    }
  });

  it('reports the daily lead quota alongside the profiles, so the agent can see the ceiling', async () => {
    const { registry, research } = build();
    const out = (await registry.get('jeeta.list_research_profiles')!.handler(CTX, {})) as {
      profiles: unknown[];
      dailyLeadQuota: unknown;
    };
    expect(research.list).toHaveBeenCalledWith('ws1');
    expect(research.usage).toHaveBeenCalledWith('ws1');
    expect(out.profiles).toHaveLength(1);
    expect(out.dailyLeadQuota).toEqual({ used: 3, limit: 10, remaining: 7 });
  });

  it('creates a profile through the service (which enforces the plan profile cap)', async () => {
    const { registry, research } = build();
    const tool = registry.get('jeeta.create_research_profile')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
    await tool.handler(CTX, { name: 'Istanbul restaurants', icpDescription: VALID_ICP, language: 'tr' });
    expect(research.create).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ name: 'Istanbul restaurants', icpDescription: VALID_ICP, language: 'tr' }),
    );
  });

  it('holds the ICP brief to the same minimum length the REST DTO does', () => {
    const { registry } = build();
    const schema = registry.get('jeeta.create_research_profile')!.inputSchema as { parse: (v: unknown) => unknown };
    expect(() => schema.parse({ name: 'n', icpDescription: 'restaurants' })).toThrow();
    expect(() => schema.parse({ name: 'n', icpDescription: VALID_ICP })).not.toThrow();
  });

  describe('run_research', () => {
    it('is SPEND — AI credits plus live scraping money', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.run_research')!;
      expect(tool.risk).toBe('SPEND');
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('AI_SPEND');
      expect(tool.resourceType).toBe('research_profile');
      expect(tool.resourceIdFrom!({ profileId: 'p1' })).toBe('p1');
    });

    /**
     * The quota is NOT re-implemented here and must not be. `enqueueNow`
     * schedules a job whose handler calls `ResearchJobService.buildJob`, which
     * reads `MarketingLeadsIngestService.usageToday` and refuses (null job)
     * when the workspace's daily lead allowance is exhausted, and caps the
     * batch by what is left. Lead ROWS are only minted later, when a staged
     * candidate is accepted, and that path goes through
     * `MarketingLeadsIngestService.ingest` → `reserveQuota`.
     */
    it('routes through the existing runner so the quota + credit path is inherited', async () => {
      const { registry, runner } = build();
      const out = await registry.get('jeeta.run_research')!.handler(CTX, { profileId: 'p1' });
      expect(runner.enqueueNow).toHaveBeenCalledWith('ws1', 'p1');
      expect(out).toMatchObject({ enqueued: true, profileId: 'p1' });
    });

    it('says in its description that results are staged for review, not turned into leads', () => {
      const { registry } = build();
      expect(registry.get('jeeta.run_research')!.description).toMatch(/review/i);
    });
  });

  it('advertises only the primary read', () => {
    const { registry } = build();
    expect(registry.listAdvertised(ALL).map((t) => t.name)).toEqual(['jeeta.list_research_profiles']);
  });

  /**
   * The review queue was unreachable over MCP until v2.178.0: an agent could
   * start a run that spends real credits and crawl money, then could not read a
   * single result. These lock the loop shut end to end.
   */
  describe('the staged review queue', () => {
    const WRITE = [...ALL, 'leads.write'];

    it('lets an agent read what a run produced, with the allowance that clips accepting', async () => {
      const { registry, candidates } = build();
      const out = (await registry.get('jeeta.list_research_candidates')!.handler(CTX, {})) as {
        candidates: unknown[];
        dailyLeadQuota: { remaining: number };
      };
      // No status passed → the service default (PENDING) must survive, not be
      // overwritten with an explicit undefined.
      expect(candidates.list).toHaveBeenCalledWith('ws1', {});
      expect(out.candidates).toHaveLength(1);
      expect(out.dailyLeadQuota.remaining).toBe(7);
    });

    it('accepts only the ids passed and reports leads created', async () => {
      const { registry, candidates } = build();
      const out = (await registry.get('jeeta.accept_research_candidates')!.handler(CTX, {
        candidateIds: ['c1'],
      })) as { accepted: number; requested: number; message: string };
      expect(candidates.accept).toHaveBeenCalledWith('ws1', ['c1']);
      expect(out).toMatchObject({ accepted: 1, requested: 1 });
      expect(out.message).toMatch(/now leads/i);
    });

    /**
     * The silent-success trap this whole session kept turning up. `accept`
     * deliberately leaves a quota-clipped candidate PENDING, so `accepted` can
     * be lower than what was asked for. Returning the bare count would read as
     * total success and the caller would never retry the remainder.
     */
    it('says so when the daily allowance clipped part of the batch', async () => {
      const { registry, candidates } = build();
      candidates.accept.mockResolvedValue({ accepted: 1, ingest: { created: 1 } });
      const out = (await registry.get('jeeta.accept_research_candidates')!.handler(CTX, {
        candidateIds: ['c1', 'c2', 'c3'],
      })) as { accepted: number; requested: number; message: string };
      expect(out).toMatchObject({ accepted: 1, requested: 3 });
      expect(out.message).toMatch(/2/);
      expect(out.message).toMatch(/PENDING/);
    });

    it('gates minting and dismissing behind approval, but never mere reading', () => {
      const { registry } = build();
      expect(registry.get('jeeta.list_research_candidates')!.requiresApproval).toBe(false);
      expect(registry.get('jeeta.list_research_candidates')!.risk).toBe('READ');
      for (const name of ['jeeta.accept_research_candidates', 'jeeta.reject_research_candidates']) {
        expect(registry.get(name)!.requiresApproval).toBe(true);
      }
    });

    it('refuses the whole queue when the research module is switched off', async () => {
      const { registry } = build({ research: false });
      for (const [name, args] of [
        ['jeeta.list_research_candidates', {}],
        ['jeeta.accept_research_candidates', { candidateIds: ['c1'] }],
        ['jeeta.reject_research_candidates', { candidateIds: ['c1'] }],
      ] as const) {
        await expect(registry.get(name)!.handler(CTX, args as never)).rejects.toThrow(/research/i);
      }
    });

    it('keeps the queue prunable so poor matches cannot bury the good ones', async () => {
      const { registry, candidates } = build();
      const out = await registry.get('jeeta.reject_research_candidates')!.handler(CTX, { candidateIds: ['c1'] });
      expect(candidates.reject).toHaveBeenCalledWith('ws1', ['c1']);
      expect(out).toMatchObject({ rejected: 1, requested: 1 });
    });

    it('needs leads.write to mint leads — settings.manage alone cannot', () => {
      const { registry } = build();
      const readOnly = registry.list(ALL).map((t) => t.name);
      expect(readOnly).not.toContain('jeeta.accept_research_candidates');
      expect(registry.list(WRITE).map((t) => t.name)).toContain('jeeta.accept_research_candidates');
    });
  });
});

/**
 * A research brief is the only object in the product that spends real money on
 * a schedule: the nightly agent picks up every ACTIVE one, forever. Creating
 * them was reachable from the agent surface and stopping them was not, so an
 * experiment switched on by an agent kept billing with no way back short of
 * the panel — the same shape as a lead stuck in a stage or a scheduled post
 * that could only be deleted.
 */
describe('jeeta.pause_research_profile', () => {
  it('pauses within the caller workspace and touches nothing else', async () => {
    const { registry, research } = build();
    await registry
      .get('jeeta.pause_research_profile')!
      .handler(CTX, { profileId: 'p1' });

    expect(research.update).toHaveBeenCalledWith('ws1', 'p1', { status: 'PAUSED' });
  });

  it('is ungated — the undo must not wait on an approval', () => {
    const { registry } = build();
    const tool = registry.get('jeeta.pause_research_profile')!;
    // Pausing only ever reduces spend. Switching a brief back ON is the verb
    // that needs a human, which is why it stays a panel action.
    expect(tool.requiresApproval).toBe(false);
    expect(tool.risk).toBe('WRITE');
    expect(tool.scopes).toEqual(['settings.manage']);
  });

  it('cannot set any status other than paused', () => {
    const { registry } = build();
    const schema = registry.get('jeeta.pause_research_profile')!.inputSchema as {
      parse: (v: unknown) => unknown;
    };
    expect(() => schema.parse({ profileId: 'p1', status: 'ACTIVE' })).toThrow();
  });
});

/**
 * The MCP research lane — the tools an owner's own Claude uses to drain the
 * nightly queue on its own Anthropic subscription instead of the platform's.
 *
 * Three lifecycle tools (claim / submit / complete) plus the three data
 * sources that stay on Jeeta's vendor keys because Claude cannot substitute
 * them: Google Maps listings and their reviews (the primary pain signal),
 * Instagram lookups, and Firecrawl-first page fetches.
 */
function buildLane(features: Record<string, boolean> = { research: true }) {
  const lease = {
    claim: jest.fn().mockResolvedValue({
      job: {
        jobId: 'job-1',
        profileId: 'p1',
        profileName: 'Salons',
        agentRunId: 'run-1',
        leaseExpiresAt: '2026-08-31T12:30:00.000Z',
        instruction: 'FULL BRIEF',
        targetVolume: 20,
        language: 'tr',
        geo: { country: 'TR' },
        businessTypes: ['SALON'],
        exclusions: null,
      },
    }),
    submit: jest.fn().mockResolvedValue({ researched: 3, staged: 2, duplicates: 1 }),
    complete: jest.fn().mockResolvedValue({ closed: true, jobId: 'job-1', status: 'DONE' }),
    toolContext: jest.fn().mockResolvedValue({
      workspaceId: 'ws1',
      runId: 'run-1',
      geo: { country: 'TR', cities: ['Izmir'] },
    }),
    queueStatus: jest.fn().mockResolvedValue({ mode: 'MCP', pending: 0, claimed: 0 }),
  };
  const sources = {
    isEnabled: () => true,
    apify: {
      isConfigured: () => true,
      searchPlaces: jest.fn().mockResolvedValue([{ name: 'Cafe X' }]),
      lookupInstagram: jest.fn().mockResolvedValue({ handle: '@cafex' }),
    },
    firecrawl: { isConfigured: () => true, scrape: jest.fn().mockResolvedValue({ markdown: 'x' }) },
    native: { isConfigured: () => false, scrape: jest.fn(), searchWeb: jest.fn() },
  };
  const spend = { settle: jest.fn().mockResolvedValue(null) };
  const runs = { recordTool: jest.fn().mockResolvedValue(undefined) };
  const registry = new McpToolRegistry();
  registerResearchTools(registry, {
    research: { list: jest.fn(), create: jest.fn(), update: jest.fn(), usage: jest.fn() },
    runner: { enqueueNow: jest.fn() },
    candidates: { list: jest.fn(), accept: jest.fn(), reject: jest.fn() },
    entitlements: { getEffective: jest.fn().mockResolvedValue({ features }) },
    lease,
    sources,
    spend,
    runs,
  } as unknown as ResearchToolDeps);
  return { registry, lease, sources, spend, runs };
}

const LANE_CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };

const LANE_TOOLS = [
  'jeeta.claim_research_job',
  'jeeta.submit_research_candidates',
  'jeeta.complete_research_job',
  'jeeta.research_search_places',
  'jeeta.research_lookup_instagram',
  'jeeta.research_scrape_page',
];

describe('research MCP lane — leasing the nightly queue to the owner Claude', () => {
  it('registers the six lane tools, all deferred and in the research domain', () => {
    const { registry } = buildLane();
    const lane = registry.list([...ALL, 'leads.write']).filter((t) => LANE_TOOLS.includes(t.name));

    expect(lane.map((t) => t.name).sort()).toEqual([...LANE_TOOLS].sort());
    for (const t of lane) {
      expect(t.domain).toBe('research');
      // The advertised surface has a hard ceiling, and every one of these is a
      // niche tool the drainer is TOLD to call by the instruction it claims.
      expect(t.defer).toBe(true);
    }
  });

  it('classifies the money-spending tools as SPEND and gates them like every other SPEND', () => {
    const { registry } = buildLane();
    for (const name of [
      'jeeta.research_search_places',
      'jeeta.research_lookup_instagram',
      'jeeta.research_scrape_page',
    ]) {
      const t = registry.get(name)!;
      // Apify and Firecrawl bill Jeeta by the call. Classifying these as plain
      // WRITE to dodge the gate would be a lie about where the money goes, and
      // this catalogue has never had an ungated SPEND.
      expect(t.risk).toBe('SPEND');
      expect(t.requiresApproval).toBe(true);
      expect(t.approvalKind).toBe('AI_SPEND');
    }
  });

  it('gates the submit, because loosening it is the owner decision this spec did not take', () => {
    const { registry } = buildLane();
    const t = registry.get('jeeta.submit_research_candidates')!;
    expect(t.risk).toBe('WRITE');
    expect(t.requiresApproval).toBe(true);
  });

  it('leaves claim and complete ungated — a gate there costs money instead of saving it', () => {
    // Claiming spends nothing (the cron already made the job) and self-reverses
    // when the lease expires. Gating the CLOSE is worse than pointless: the job
    // would sit leased until it expired and then be researched a second time.
    const { registry } = buildLane();
    for (const name of ['jeeta.claim_research_job', 'jeeta.complete_research_job']) {
      const t = registry.get(name)!;
      expect(t.risk).toBe('WRITE');
      expect(t.requiresApproval).toBe(false);
    }
  });

  it('claim returns the whole server-authored instruction', async () => {
    const { registry, lease } = buildLane();
    const res: any = await registry.get('jeeta.claim_research_job')!.handler(LANE_CTX, {});
    expect(lease.claim).toHaveBeenCalledWith('ws1');
    expect(res.job.instruction).toBe('FULL BRIEF');
    expect(res.job.jobId).toBe('job-1');
  });

  it('claim SAYS why there is nothing rather than returning an empty object', async () => {
    // "no job tonight" and "this workspace is not on the MCP lane at all" need
    // opposite fixes, and a drainer that cannot tell them apart polls forever
    // against a workspace whose jobs the platform is already draining.
    const { registry, lease } = buildLane();
    lease.claim.mockResolvedValue({ job: null, reason: 'not-in-mcp-mode' });
    const res: any = await registry.get('jeeta.claim_research_job')!.handler(LANE_CTX, {});
    expect(res.job).toBeNull();
    expect(res.reason).toBe('not-in-mcp-mode');
    expect(res.message).toMatch(/MCP/);
  });

  it('submit routes to the shared staging path and reports duplicates honestly', async () => {
    const { registry, lease } = buildLane();
    const res: any = await registry.get('jeeta.submit_research_candidates')!.handler(LANE_CTX, {
      jobId: 'job-1',
      candidates: [
        {
          externalRef: 'phone:+905551112233',
          businessName: 'X',
          businessType: 'CAFE',
          painPoint: 'p',
          evidence: 'e',
          pitch: 'q',
        },
      ],
    });
    expect(lease.submit).toHaveBeenCalledWith(
      'ws1',
      'job-1',
      expect.arrayContaining([expect.objectContaining({ businessName: 'X' })]),
    );
    expect(res).toMatchObject({ staged: 2, duplicates: 1, researched: 3 });
    expect(res.message).toMatch(/review/i);
  });

  it('complete closes the job with the reason it was given', async () => {
    const { registry, lease } = buildLane();
    await registry.get('jeeta.complete_research_job')!.handler(LANE_CTX, {
      jobId: 'job-1',
      status: 'FAILED',
      reason: 'apify returned nothing',
    });
    expect(lease.complete).toHaveBeenCalledWith('ws1', 'job-1', {
      status: 'FAILED',
      reason: 'apify returned nothing',
    });
  });

  it('resolves the data tools run id and geo from the LEASE, never from the caller', async () => {
    // This is the isolation predicate for the three vendor-billed tools: the
    // run a ToolCallLog and an Apify meter are attributed to, and the geo the
    // brief promised, both come from the server's record of the leased job.
    const { registry, lease, sources, spend } = buildLane();

    await registry
      .get('jeeta.research_search_places')!
      .handler(LANE_CTX, { jobId: 'job-1', query: 'salon' });

    expect(lease.toolContext).toHaveBeenCalledWith('ws1', 'job-1');
    expect(sources.apify.searchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'salon', geo: { country: 'TR', cities: ['Izmir'] } }),
    );
    expect(spend.settle).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ unit: 'APIFY_RUN', ref: 'run-1' }),
    );
  });

  it('logs every vendor-billed call against the leased run', async () => {
    const { registry, runs } = buildLane();
    await registry
      .get('jeeta.research_scrape_page')!
      .handler(LANE_CTX, { jobId: 'job-1', url: 'https://x.test' });
    expect(runs.recordTool).toHaveBeenCalledWith(
      'ws1',
      'run-1',
      expect.objectContaining({ tool: 'scrape_page' }),
    );
  });

  it('accepts no workspaceId on any lane tool', () => {
    const { registry } = buildLane();
    for (const name of LANE_TOOLS) {
      const schema = registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown };
      expect(() => schema.parse({ workspaceId: 'ws-b' })).toThrow();
    }
  });

  it('gates the whole lane on the research module', async () => {
    const { registry } = buildLane({});
    const calls: Array<[string, Record<string, unknown>]> = [
      ['jeeta.claim_research_job', {}],
      ['jeeta.submit_research_candidates', { jobId: 'j', candidates: [] }],
      ['jeeta.complete_research_job', { jobId: 'j', status: 'DONE' }],
      ['jeeta.research_search_places', { jobId: 'j', query: 'q' }],
      ['jeeta.research_lookup_instagram', { jobId: 'j', handle: '@x' }],
      ['jeeta.research_scrape_page', { jobId: 'j', url: 'https://x.test' }],
    ];
    for (const [name, args] of calls) {
      await expect(registry.get(name)!.handler(LANE_CTX, args)).rejects.toMatchObject({
        response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'research' },
      });
    }
  });
});
