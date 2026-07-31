import { McpToolRegistry } from '../mcp-tool-registry';
import { registerResearchTools, ResearchToolDeps } from './research.tools';

function build(features: Record<string, boolean> = { research: true }) {
  const research = {
    list: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Istanbul restaurants' }]),
    create: jest.fn().mockResolvedValue({ id: 'p1', status: 'ACTIVE' }),
    usage: jest.fn().mockResolvedValue({ used: 3, limit: 10, remaining: 7 }),
  };
  const runner = { enqueueNow: jest.fn().mockResolvedValue(undefined) };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features }) };
  const registry = new McpToolRegistry();
  registerResearchTools(registry, { research, runner, entitlements } as unknown as ResearchToolDeps);
  return { registry, research, runner, entitlements };
}

const CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };
const ALL = ['settings.manage'];
const VALID_ICP =
  'Independent restaurants in Istanbul with 2 to 10 branches that still take phone orders on paper and have no POS integration.';

describe('Faz 5 D4 — research/prospecting MCP tools', () => {
  it('registers exactly the three research tools in the research domain', () => {
    const { registry } = build();
    const tools = registry.list(ALL);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['jeeta.list_research_profiles', 'jeeta.create_research_profile', 'jeeta.run_research'].sort(),
    );
    for (const t of tools) {
      expect(t.domain).toBe('research');
      expect(t.scopes).toEqual(['settings.manage']);
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
});
