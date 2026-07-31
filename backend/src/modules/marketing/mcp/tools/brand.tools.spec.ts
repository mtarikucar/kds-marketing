import { McpToolRegistry } from '../mcp-tool-registry';
import { registerBrandTools } from './brand.tools';

function fullDeps(over: Record<string, unknown> = {}) {
  return {
    brand: { search: jest.fn().mockResolvedValue([]) },
    profiles: {
      get: jest.fn().mockResolvedValue({ brandName: 'Jeeta', status: 'ACTIVE' }),
      upsert: jest.fn().mockResolvedValue({ brandName: 'Jeeta', tagline: 'grow' }),
    },
    ...over,
  } as any;
}

describe('brand MCP tools', () => {
  it('registers jeeta.search_brand_knowledge as READ/reports.read', () => {
    const registry = new McpToolRegistry();
    registerBrandTools(registry, fullDeps());
    const tool = registry.get('jeeta.search_brand_knowledge')!;
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(['reports.read']);
    expect(tool.inputSchema).toBeDefined();
  });

  it('passes the query through to BrandBrainService.search', async () => {
    const registry = new McpToolRegistry();
    const search = jest.fn().mockResolvedValue([{ docId: 'd1' }]);
    registerBrandTools(registry, fullDeps({ brand: { search } }));
    const out = await registry.get('jeeta.search_brand_knowledge')!.handler(
      { workspaceId: 'ws1', grantedScopes: ['reports.read'] },
      { query: 'tone of voice' },
    );
    expect(search).toHaveBeenCalledWith('ws1', expect.objectContaining({ queryText: 'tone of voice' }));
    expect(out).toEqual([{ docId: 'd1' }]);
  });

  describe('Faz 5 D4 — brand profile read/write', () => {
    const CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };

    function build(over: Record<string, unknown> = {}) {
      const deps = fullDeps(over);
      const registry = new McpToolRegistry();
      registerBrandTools(registry, deps);
      return { registry, deps };
    }

    it('classifies the profile pair: READ on reports.read, WRITE on settings.manage', () => {
      const { registry } = build();
      const read = registry.get('jeeta.get_brand_profile')!;
      expect(read.risk).toBe('READ');
      expect(read.scopes).toEqual(['reports.read']);
      expect(read.domain).toBe('brand');

      const write = registry.get('jeeta.update_brand_profile')!;
      expect(write.risk).toBe('WRITE');
      // The panel gates PUT /brand-brain/profile on MANAGER + settings.manage.
      expect(write.scopes).toEqual(['settings.manage']);
      // Brand copy is configuration: reversible, workspace-internal, nothing
      // is sent or spent. Gating it would make every tone tweak an approval.
      expect(write.requiresApproval).toBe(false);
    });

    it('reads the profile, and explains itself when there is none', async () => {
      const { registry, deps } = build();
      await registry.get('jeeta.get_brand_profile')!.handler(CTX, {});
      expect(deps.profiles.get).toHaveBeenCalledWith('ws1');

      const empty = build({ profiles: { get: jest.fn().mockResolvedValue(null), upsert: jest.fn() } });
      const out = (await empty.registry.get('jeeta.get_brand_profile')!.handler(CTX, {})) as {
        profile: null;
        message: string;
      };
      expect(out.profile).toBeNull();
      expect(out.message).toMatch(/brand/i);
    });

    it('upserts only the fields the caller supplied (a partial edit must not blank the rest)', async () => {
      const { registry, deps } = build();
      await registry.get('jeeta.update_brand_profile')!.handler(CTX, { tagline: 'Grow on autopilot' });
      expect(deps.profiles.upsert).toHaveBeenCalledWith('ws1', { tagline: 'Grow on autopilot' });
    });

    it('refuses an empty update rather than silently doing nothing', async () => {
      const { registry, deps } = build();
      await expect(registry.get('jeeta.update_brand_profile')!.handler(CTX, {})).rejects.toThrow(/at least one/i);
      expect(deps.profiles.upsert).not.toHaveBeenCalled();
    });

    it('keeps search advertised and defers the profile pair', () => {
      const { registry } = build();
      expect(registry.listAdvertised(['reports.read', 'settings.manage']).map((t) => t.name)).toEqual([
        'jeeta.search_brand_knowledge',
      ]);
    });
  });
});
