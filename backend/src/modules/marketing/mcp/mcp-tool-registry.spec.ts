import { z } from 'zod';
import { McpTool, McpToolRegistry } from './mcp-tool-registry';

function tool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'jeeta.example',
    description: 'an example tool',
    domain: 'leads',
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async () => null,
    ...overrides,
  };
}

describe('McpToolRegistry', () => {
  it('registers a well-formed tool', () => {
    const registry = new McpToolRegistry();
    registry.register(tool());
    expect(registry.has('jeeta.example')).toBe(true);
    expect(registry.get('jeeta.example')).toBeDefined();
  });

  // Found live: `search_leads({query: "X"})` — the caller meant `search` —
  // parsed to `{}` and returned every lead in the workspace, which reads to an
  // agent as "these are the X leads". Registration makes the schema strict so
  // the mistake surfaces as an error the model can correct, instead of as
  // confidently wrong data.
  it('makes an object schema strict, so an undeclared argument is rejected rather than silently dropped', () => {
    const registry = new McpToolRegistry();
    registry.register(tool({ inputSchema: z.object({ search: z.string().optional() }) }));

    const schema = registry.get('jeeta.example')!.inputSchema;
    expect(schema.safeParse({ search: 'ok' }).success).toBe(true);
    expect(schema.safeParse({ qeury: 'typo' }).success).toBe(false);
  });

  it('leaves a non-object schema untouched (nothing to tighten)', () => {
    const registry = new McpToolRegistry();
    const passthrough = z.any();
    registry.register(tool({ inputSchema: passthrough }));
    expect(registry.get('jeeta.example')!.inputSchema).toBe(passthrough);
  });

  it('throws when a tool is registered without inputSchema', () => {
    const registry = new McpToolRegistry();
    // Cast through unknown: TypeScript would already catch this at the call
    // site (inputSchema is required on McpTool), but spec files are excluded
    // from type-checking (tsconfig `**/*.spec.ts` exclude + ts-jest
    // `diagnostics: false`), so a misregistered tool can reach `register()`
    // at runtime with no schema. This proves the runtime guard catches it.
    const broken = tool();
    delete (broken as { inputSchema?: unknown }).inputSchema;

    expect(() => registry.register(broken)).toThrow(/inputSchema/);
    expect(registry.has('jeeta.example')).toBe(false);
  });
});

describe('McpToolRegistry progressive disclosure (spec §3)', () => {
  /**
   * The tripwire: a new tool that forgets `domain` must fail CI. Without it the
   * tool is invisible to `jeeta.find_tools`'s domain match and unclassifiable
   * into the advertised core — and if it were also deferred, unreachable.
   */
  it('refuses a tool with no domain', () => {
    const registry = new McpToolRegistry();
    const broken = tool();
    delete (broken as { domain?: unknown }).domain;
    expect(() => registry.register(broken)).toThrow(/domain/i);
    expect(registry.has('jeeta.example')).toBe(false);
  });

  it('refuses a tool whose domain is not in the vocabulary', () => {
    const registry = new McpToolRegistry();
    expect(() => registry.register(tool({ domain: 'telepathy' as never }))).toThrow(/domain/i);
  });

  /**
   * Faz 5 D5 — the commerce wave's three new domains. Spec files are excluded
   * from type-checking, so the `ToolDomain` union alone would not catch a
   * missing runtime entry in `TOOL_DOMAINS`; this pins both halves.
   */
  it.each(['commerce', 'courses', 'reviews'])('accepts the D5 domain %s', (domain) => {
    const registry = new McpToolRegistry();
    expect(() => registry.register(tool({ domain: domain as never }))).not.toThrow();
    expect(registry.get('jeeta.example')!.domain).toBe(domain);
  });

  it('omits deferred tools from the advertised list but keeps them callable', () => {
    const registry = new McpToolRegistry();
    registry.register(tool({ name: 'jeeta.core' }));
    registry.register(tool({ name: 'jeeta.niche', defer: true }));

    expect(registry.listAdvertised(['leads.read']).map((t) => t.name)).toEqual(['jeeta.core']);
    // Still in the full catalogue, still resolvable by the broker: deferral is
    // an advertising decision, never a permission one.
    expect(registry.list(['leads.read']).map((t) => t.name).sort()).toEqual(['jeeta.core', 'jeeta.niche']);
    expect(registry.get('jeeta.niche')).toBeDefined();
  });

  it('searches name, description and domain, and ranks multi-term hits first', () => {
    const registry = new McpToolRegistry();
    registry.register({
      ...tool({ name: 'jeeta.click_to_dial' }),
      domain: 'voice',
      description: 'Place a real phone call to a lead.',
    });
    registry.register({
      ...tool({ name: 'jeeta.search_leads' }),
      domain: 'leads',
      description: 'Search the lead database.',
    });

    expect(registry.search(['leads.read'], 'voice').map((t) => t.name)).toEqual(['jeeta.click_to_dial']);
    expect(registry.search(['leads.read'], 'phone call').map((t) => t.name)).toEqual(['jeeta.click_to_dial']);
    expect(registry.search(['leads.read'], 'dial').map((t) => t.name)).toEqual(['jeeta.click_to_dial']);
    // Both mention "lead"; the one that also matches "search" ranks first.
    expect(registry.search(['leads.read'], 'search lead')[0].name).toBe('jeeta.search_leads');
    expect(registry.search(['leads.read'], 'quokka')).toEqual([]);
    expect(registry.search(['leads.read'], '')).toHaveLength(2);
  });

  it('never surfaces a tool the caller lacks the scope for, deferred or not', () => {
    const registry = new McpToolRegistry();
    registry.register(tool({ name: 'jeeta.secret', scopes: ['campaigns.send'], defer: true }));
    expect(registry.search(['leads.read'], 'secret')).toEqual([]);
    expect(registry.list(['leads.read'])).toEqual([]);
  });
});
