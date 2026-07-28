import { McpToolRegistry } from '../mcp-tool-registry';
import { registerBrandTools } from './brand.tools';

describe('brand MCP tools', () => {
  it('registers jeeta.search_brand_knowledge as READ/reports.read', () => {
    const registry = new McpToolRegistry();
    registerBrandTools(registry, { brand: { search: jest.fn() } as any });
    const tool = registry.get('jeeta.search_brand_knowledge')!;
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(['reports.read']);
    expect(tool.inputSchema).toBeDefined();
  });

  it('passes the query through to BrandBrainService.search', async () => {
    const registry = new McpToolRegistry();
    const search = jest.fn().mockResolvedValue([{ docId: 'd1' }]);
    registerBrandTools(registry, { brand: { search } as any });
    const out = await registry.get('jeeta.search_brand_knowledge')!.handler(
      { workspaceId: 'ws1', grantedScopes: ['reports.read'] },
      { query: 'tone of voice' },
    );
    expect(search).toHaveBeenCalledWith('ws1', expect.objectContaining({ queryText: 'tone of voice' }));
    expect(out).toEqual([{ docId: 'd1' }]);
  });
});
