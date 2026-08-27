import { z } from 'zod';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry } from './mcp-tool-registry';

/**
 * A dropped OPTIONAL argument is usually a FILTER, and a dropped filter turns
 * "the Acme leads" into the whole workspace's first page — returned under
 * status OK, which is the one shape a model has no way to doubt.
 *
 * assertArgs deliberately keeps ACCEPTING unknown keys (rejecting them would
 * break calls that work today, which its own comment promises not to do). What
 * these pin is that it no longer does so in silence.
 */
describe('McpBrokerService — ignored arguments are reported, not swallowed', () => {
  const handler = jest.fn().mockResolvedValue({ rows: ['everything'] });

  const make = () => {
    const registry = new McpToolRegistry();
    registry.register({
      name: 'jeeta.search_leads',
      description: 'x',
      domain: 'leads',
      scopes: ['leads.read'],
      risk: 'READ',
      requiresApproval: false,
      inputSchema: z.object({ search: z.string().optional() }),
      handler,
    });
    const broker = new McpBrokerService(
      registry,
      { create: jest.fn() } as never,
      { recordTool: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return broker;
  };

  const ctx = { workspaceId: 'ws1', grantedScopes: ['leads.read'] } as never;

  it('names the argument it ignored', async () => {
    const res = await make().invoke(ctx, 'jeeta.search_leads', { query: 'Acme' });

    // The tool still ran — the guard's promise is intact.
    expect(res.status).toBe('OK');
    expect(handler).toHaveBeenCalled();
    // But the caller is told its filter never applied.
    expect(res.ignoredArgs).toEqual(['query']);
  });

  it('says nothing when every argument is understood', async () => {
    const res = await make().invoke(ctx, 'jeeta.search_leads', { search: 'Acme' });
    expect(res.status).toBe('OK');
    expect(res.ignoredArgs).toBeUndefined();
  });

  it('still rejects a misspelling that leaves a REQUIRED field missing', async () => {
    const registry = new McpToolRegistry();
    registry.register({
      name: 'jeeta.needs_id',
      description: 'x',
      domain: 'leads',
      scopes: ['leads.read'],
      risk: 'READ',
      requiresApproval: false,
      inputSchema: z.object({ leadId: z.string() }),
      handler: jest.fn(),
    });
    const broker = new McpBrokerService(
      registry,
      { create: jest.fn() } as never,
      { recordTool: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(broker.invoke(ctx, 'jeeta.needs_id', { leadID: 'x' })).rejects.toThrow(
      /invalid arguments/,
    );
  });
});
