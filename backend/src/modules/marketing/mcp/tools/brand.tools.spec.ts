import { McpToolRegistry } from '../mcp-tool-registry';
import { registerBrandTools } from './brand.tools';

function fullDeps(over: Record<string, unknown> = {}) {
  return {
    brand: { search: jest.fn().mockResolvedValue([]), indexDoc: jest.fn().mockResolvedValue(2) },
    knowledge: {
      create: jest.fn().mockResolvedValue({ id: 'kd1', title: 'Refund policy', language: 'tr', status: 'ACTIVE' }),
      list: jest.fn().mockResolvedValue([{ id: 'kd1', title: 'Refund policy', status: 'ACTIVE' }]),
      remove: jest.fn().mockResolvedValue({ message: 'Knowledge doc deleted' }),
    },
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

  describe('brand knowledge documents — add / list / delete', () => {
    const CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };

    function build(over: Record<string, unknown> = {}) {
      const deps = fullDeps(over);
      const registry = new McpToolRegistry();
      registerBrandTools(registry, deps);
      return { registry, deps };
    }

    it('classifies the three tools: add WRITE, list READ, delete DESTRUCTIVE behind approval', () => {
      const { registry } = build();
      const add = registry.get('jeeta.add_brand_knowledge')!;
      expect(add).toMatchObject({ risk: 'WRITE', requiresApproval: false, domain: 'brand' });
      // The panel gates POST /ai/knowledge on MANAGER + settings.manage.
      expect(add.scopes).toEqual(['settings.manage']);

      const list = registry.get('jeeta.list_brand_knowledge')!;
      expect(list).toMatchObject({ risk: 'READ', requiresApproval: false, domain: 'brand' });
      expect(list.scopes).toEqual(['reports.read']);

      const del = registry.get('jeeta.delete_brand_knowledge')!;
      expect(del).toMatchObject({
        risk: 'DESTRUCTIVE',
        requiresApproval: true,
        approvalKind: 'DESTRUCTIVE',
        resourceType: 'knowledge_doc',
        domain: 'brand',
      });
      expect(del.scopes).toEqual(['settings.manage']);
      expect(del.resourceIdFrom!({ docId: 'kd1' })).toBe('kd1');
    });

    it('add creates the doc through KnowledgeService (package limit lives there) and indexes it for search', async () => {
      const { registry, deps } = build();
      const out = (await registry.get('jeeta.add_brand_knowledge')!.handler(CTX, {
        title: 'Refund policy',
        content: '# Refunds\n\n14 days, no questions.',
      })) as { doc: { id: string }; chunks: number; searchable: boolean };
      expect(deps.knowledge.create).toHaveBeenCalledWith('ws1', {
        title: 'Refund policy',
        content: '# Refunds\n\n14 days, no questions.',
        language: 'tr',
        source: 'MANUAL',
      });
      expect(deps.brand.indexDoc).toHaveBeenCalledWith('ws1', 'kd1', {
        title: 'Refund policy',
        content: '# Refunds\n\n14 days, no questions.',
      });
      expect(out).toMatchObject({ doc: { id: 'kd1' }, chunks: 2, searchable: true });
    });

    it('add folds tags into the stored content so they are searchable and visible in the panel', async () => {
      const { registry, deps } = build();
      await registry.get('jeeta.add_brand_knowledge')!.handler(CTX, {
        title: 'Workshop',
        content: 'Atölye cumartesi.',
        tags: ['atölye', 'etkinlik'],
        language: 'en',
      });
      const dto = deps.knowledge.create.mock.calls[0][1];
      expect(dto.content).toBe('Atölye cumartesi.\n\nTags: atölye, etkinlik');
      expect(dto.language).toBe('en');
      expect(deps.brand.indexDoc.mock.calls[0][2].content).toBe(dto.content);
    });

    it('add surfaces the package limit refusal and indexes nothing', async () => {
      const create = jest.fn().mockRejectedValue(new Error('Knowledge doc limit reached (500) — upgrade your package'));
      const { registry, deps } = build({
        knowledge: { create, list: jest.fn(), remove: jest.fn() },
      });
      await expect(
        registry.get('jeeta.add_brand_knowledge')!.handler(CTX, { title: 't', content: 'c' }),
      ).rejects.toThrow(/limit reached/);
      expect(deps.brand.indexDoc).not.toHaveBeenCalled();
    });

    it('add reports a created-but-unindexed doc instead of failing (a retry would duplicate it)', async () => {
      const { registry } = build({
        brand: { search: jest.fn(), indexDoc: jest.fn().mockRejectedValue(new Error('db down')) },
      });
      const out = (await registry.get('jeeta.add_brand_knowledge')!.handler(CTX, { title: 't', content: 'c' })) as {
        doc: { id: string };
        searchable: boolean;
        message: string;
      };
      expect(out.doc.id).toBe('kd1');
      expect(out.searchable).toBe(false);
      expect(out.message).toMatch(/reindex/i);
    });

    it('add enforces the 50k markdown cap and a non-empty title in the schema', () => {
      const { registry } = build();
      const schema = registry.get('jeeta.add_brand_knowledge')!.inputSchema;
      expect(() => schema.parse({ title: 'ok', content: 'x'.repeat(50_000) })).not.toThrow();
      expect(() => schema.parse({ title: 'ok', content: 'x'.repeat(50_001) })).toThrow();
      expect(() => schema.parse({ title: '', content: 'x' })).toThrow();
      expect(() => schema.parse({ title: 'ok', content: '' })).toThrow();
      expect(() => schema.parse({ title: 'ok', content: 'x', tags: Array(21).fill('t') })).toThrow();
    });

    it('counts the Tags line against the 50k cap, so the panel can still save the doc', async () => {
      // The panel PATCHes the whole stored content back (UpdateKnowledgeDto
      // @MaxLength(50000)); a doc stored longer than that can never be edited.
      const { registry, deps } = build();
      const tool = registry.get('jeeta.add_brand_knowledge')!;
      const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
      const tagLine = `

Tags: ${tags.join(', ')}`;
      await expect(
        tool.handler(CTX, { title: 't', content: 'x'.repeat(50_000 - tagLine.length + 1), tags }),
      ).rejects.toThrow(/50000/);
      expect(deps.knowledge.create).not.toHaveBeenCalled();

      await tool.handler(CTX, { title: 't', content: 'x'.repeat(50_000 - tagLine.length), tags });
      expect(deps.knowledge.create.mock.calls[0][1].content).toHaveLength(50_000);
    });

    it('list returns the workspace docs with a count', async () => {
      const { registry, deps } = build();
      const out = (await registry.get('jeeta.list_brand_knowledge')!.handler(CTX, {})) as {
        docs: unknown[];
        count: number;
      };
      expect(deps.knowledge.list).toHaveBeenCalledWith('ws1');
      expect(out.count).toBe(1);
      expect(out.docs).toHaveLength(1);
    });

    it('delete removes by id inside the caller workspace', async () => {
      const { registry, deps } = build();
      await registry.get('jeeta.delete_brand_knowledge')!.handler(CTX, { docId: 'kd1' });
      expect(deps.knowledge.remove).toHaveBeenCalledWith('ws1', 'kd1');
    });

    it('defers all three (the advertised ceiling is full); find_tools reaches them by domain', () => {
      const { registry } = build();
      for (const n of ['jeeta.add_brand_knowledge', 'jeeta.list_brand_knowledge', 'jeeta.delete_brand_knowledge']) {
        expect(registry.get(n)!.defer).toBe(true);
      }
    });
  });
});
