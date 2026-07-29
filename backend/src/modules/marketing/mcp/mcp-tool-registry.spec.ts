import { z } from 'zod';
import { McpTool, McpToolRegistry } from './mcp-tool-registry';

function tool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'jeeta.example',
    description: 'an example tool',
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
