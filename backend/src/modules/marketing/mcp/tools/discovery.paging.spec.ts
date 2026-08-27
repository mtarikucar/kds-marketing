import { McpToolRegistry } from '../mcp-tool-registry';
import { registerDiscoveryTools } from './discovery.tools';
import { z } from 'zod';

/**
 * find_tools promises "omit query to list the entire catalogue you have access
 * to". With a hard cap of 60 against a 114-tool registry it could not keep that
 * promise: the caller got the same first 60 every time, the cut was silent, and
 * because the order is registration order it was always the same tail — the
 * domains registered last never appeared in an unfiltered list at all.
 */
describe('jeeta.find_tools — paging past the cap', () => {
  const SCOPES = ['leads.read'];

  const makeRegistry = (n: number) => {
    const registry = new McpToolRegistry();
    for (let i = 0; i < n; i++) {
      registry.register({
        name: `jeeta.t${String(i).padStart(3, '0')}`,
        description: 'x',
        domain: 'leads',
        scopes: ['leads.read'],
        risk: 'READ',
        requiresApproval: false,
        inputSchema: z.object({}),
        handler: jest.fn(),
      });
    }
    registerDiscoveryTools(registry, { registry } as never);
    return registry;
  };

  const find = (registry: McpToolRegistry, args: Record<string, unknown>) =>
    registry.get('jeeta.find_tools')!.handler(
      { workspaceId: 'ws1', grantedScopes: SCOPES } as never,
      args,
    ) as Promise<{
      total: number;
      returned: number;
      offset: number;
      nextOffset?: number;
      tools: Array<{ name: string }>;
    }>;

  it('reports how to reach the rest when the result set exceeds the cap', async () => {
    const registry = makeRegistry(100);
    const page = await find(registry, { limit: 60 });

    expect(page.returned).toBe(60);
    expect(page.offset).toBe(0);
    // The presence of nextOffset IS the "there is more" signal.
    expect(page.nextOffset).toBe(60);
  });

  it('returns the tail that used to be unreachable', async () => {
    const registry = makeRegistry(100);
    const first = await find(registry, { limit: 60 });
    const rest = await find(registry, { limit: 60, offset: first.nextOffset });

    const seen = new Set([...first.tools, ...rest.tools].map((t) => t.name));
    // Every tool in the catalogue is reachable by listing, which is what the
    // description has always claimed.
    expect(seen.size).toBe(first.total);
    // And the last-registered tool — the one always cut before — is in there.
    expect(seen.has('jeeta.t099')).toBe(true);
  });

  it('omits nextOffset on the final page, so paging terminates', async () => {
    const registry = makeRegistry(100);
    // registerDiscoveryTools adds its own tools, so derive the tail size from
    // `total` rather than assuming the count handed to makeRegistry.
    const last = await find(registry, { limit: 60, offset: 60 });

    expect(last.returned).toBe(last.total - 60);
    expect(last.nextOffset).toBeUndefined();
  });

  it('is unchanged for a caller that never pages', async () => {
    const registry = makeRegistry(10);
    const page = await find(registry, {});
    expect(page.returned).toBe(page.total);
    expect(page.offset).toBe(0);
    expect(page.nextOffset).toBeUndefined();
  });
});
