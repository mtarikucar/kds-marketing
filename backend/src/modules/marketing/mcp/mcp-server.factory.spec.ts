import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { McpToolRegistry } from './mcp-tool-registry';
import { McpServerFactoryService } from './mcp-server.factory';
import type { AuthInfo } from '@modelcontextprotocol/server';

const authInfo = (scopes: string[]): AuthInfo =>
  ({ token: 't', clientId: 'k1', scopes, expiresAt: Math.floor(Date.now() / 1000) + 60, extra: { workspaceId: 'ws1' } }) as AuthInfo;

/** Reads the SDK's OWN registered-tool map off a built server, not our assumptions about it. */
const registeredToolNames = (server: unknown): string[] => Object.keys((server as any)._registeredTools ?? {});

function deps() {
  const registry = new McpToolRegistry();
  registry.register({
    name: 'jeeta.get_funnel',
    description: 'funnel',
    domain: 'analytics',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({ from: z.string().optional(), to: z.string().optional() }),
    handler: jest.fn(),
  });
  const invoke = jest.fn().mockResolvedValue({ status: 'OK', result: { stages: [] } });
  const factory = new McpServerFactoryService(registry, { invoke } as any);
  return { factory, invoke, registry };
}

describe('McpServerFactoryService', () => {
  it('builds a server exposing the scoped tools', async () => {
    const { factory } = deps();
    const server = factory.build({ era: 'modern', authInfo: authInfo(['reports.read']) } as any);
    expect(server).toBeDefined();
    // Assert against the SDK's actual registered-tool set, not just that
    // `build()` returned something — this would still pass if the
    // registration loop were deleted from `build()` otherwise.
    expect(registeredToolNames(server)).toEqual(['jeeta.get_funnel']);
  });

  it('refuses to build without authInfo', () => {
    const { factory } = deps();
    expect(() => factory.build({ era: 'modern' } as any)).toThrow(/auth/i);
  });

  it('exposes no tools to a caller lacking the scope', () => {
    const { factory, registry } = deps();
    expect(registry.list(['leads.read'])).toHaveLength(0);
    const server = factory.build({ era: 'modern', authInfo: authInfo(['leads.read']) } as any);
    expect(registeredToolNames(server)).toHaveLength(0);
  });
});

describe('McpServerFactoryService progressive disclosure (spec §3)', () => {
  function withDeferred() {
    const { factory, registry, invoke } = deps();
    registry.register({
      name: 'jeeta.delete_thing',
      description: 'a niche destructive one-off',
      domain: 'social',
      defer: true,
      scopes: ['reports.read'],
      risk: 'DESTRUCTIVE',
      requiresApproval: true,
      inputSchema: z.object({ id: z.string() }),
      handler: jest.fn(),
    });
    return { factory, registry, invoke };
  }

  it('REGISTERS deferred tools with the SDK (they stay callable), but does not advertise them', () => {
    const { factory } = withDeferred();
    const server: any = factory.build({ era: 'modern', authInfo: authInfo(['reports.read']) } as any);

    // Callable: the SDK knows the tool, so a tools/call by name dispatches.
    expect(registeredToolNames(server).sort()).toEqual(['jeeta.delete_thing', 'jeeta.get_funnel']);
    expect(server._registeredTools['jeeta.delete_thing'].enabled).toBe(true);

    // Advertised: only the core survives into tools/list.
    const listed = factory.advertisedTools(server, ['reports.read']).tools.map((t) => t.name);
    expect(listed).toEqual(['jeeta.get_funnel']);
  });

  it('advertises the SDK\'s own JSON Schema for the tools it does list', () => {
    const { factory } = withDeferred();
    const server: any = factory.build({ era: 'modern', authInfo: authInfo(['reports.read']) } as any);
    const [funnel] = factory.advertisedTools(server, ['reports.read']).tools;
    expect(funnel.inputSchema).toEqual(server.toolInputSchemaJson('jeeta.get_funnel'));
    expect((funnel.inputSchema as any).properties).toHaveProperty('from');
  });

  /**
   * The override has to be the handler the transport actually dispatches, or
   * the deferred tools would still be advertised by the SDK's stock handler.
   */
  it('installs the filtered handler as the server\'s real tools/list handler', () => {
    const { factory } = withDeferred();
    const server: any = factory.build({ era: 'modern', authInfo: authInfo(['reports.read']) } as any);
    expect(server.server._requestHandlers.has('tools/list')).toBe(true);
  });

  /**
   * A caller whose scopes match nothing must get a server with NO tool surface
   * — the SDK never installed its tool handlers, so overriding `tools/list`
   * there would throw ("Server does not support tools").
   */
  it('advertises nothing, and installs no handler, for a caller lacking every scope', () => {
    const { factory } = withDeferred();
    const server: any = factory.build({ era: 'modern', authInfo: authInfo(['leads.read']) } as any);
    expect(registeredToolNames(server)).toHaveLength(0);
    expect(server.server._requestHandlers.has('tools/list')).toBe(false);
  });
});

describe('McpServerFactoryService error mapping', () => {
  it('turns a broker rejection into an isError tool result, not a thrown exception', async () => {
    const { factory, invoke } = deps();
    invoke.mockRejectedValue(new ForbiddenException('missing scope(s): leads.write'));
    const server: any = factory.build({ era: 'modern', authInfo: authInfo(['reports.read']) } as any);
    const handler = factory.handlerFor(authInfo(['reports.read']), 'jeeta.get_funnel');
    const out = await handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/missing scope/i);
    expect(server).toBeDefined();
  });

  it('surfaces a pending approval as normal content, not an error', async () => {
    const { factory, invoke } = deps();
    invoke.mockResolvedValue({ status: 'PENDING_APPROVAL', approvalId: 'appr-9' });
    const handler = factory.handlerFor(authInfo(['reports.read']), 'jeeta.get_funnel');
    const out = await handler({});
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain('appr-9');
  });
});

describe('McpServerFactoryService SDK dispatch (regression coverage for the dropped-args defect)', () => {
  /**
   * The installed @modelcontextprotocol/server (`dist/mcp-*.mjs`,
   * `createToolExecutor`) picks the tool callback's calling convention off
   * whether `registerTool`'s config carries an `inputSchema`:
   *   - WITH inputSchema:    executor(args, ctx) -> handler(args, ctx)
   *   - WITHOUT inputSchema: executor(args, ctx) -> handler(ctx)   [args dropped]
   *
   * `build()` in mcp-server.factory.ts MUST pass `inputSchema: meta.inputSchema`
   * or every tool call silently receives the SDK's ServerContext (which
   * carries the caller's live `authInfo`/bearer token) in place of the real
   * arguments — and that would flow straight into the audit log.
   *
   * This test dispatches through the real SDK-built `executor` for the
   * registered tool (the exact function `registerTool` constructs), not a
   * hand-rolled stand-in, so it fails if `inputSchema` is ever dropped from
   * that `registerTool` call. Confirmed by temporarily deleting
   * `inputSchema: meta.inputSchema` from `build()`: this test failed with
   * the received "args" being the ServerContext object instead of
   * `{ from, to }`; restoring the line fixed it.
   */
  it('delivers the caller arguments to the invoker, never the ServerContext', async () => {
    const { factory, invoke } = deps();
    const info = authInfo(['reports.read']);
    const server: any = factory.build({ era: 'modern', authInfo: info } as any);

    const registeredTool = server._registeredTools['jeeta.get_funnel'];
    expect(registeredTool).toBeDefined();
    expect(typeof registeredTool.executor).toBe('function');

    const realArgs = { from: '2026-07-01', to: '2026-07-28' };
    // Stand-in for the SDK's real per-call ServerContext, which always
    // carries the caller's bearer authInfo — exactly what must NOT leak into
    // the invoker/broker/audit-log as if it were tool "args".
    const serverContext = { authInfo: info, requestId: 'req-1' };

    await registeredTool.executor(realArgs, serverContext);

    expect(invoke).toHaveBeenCalledWith(info, 'jeeta.get_funnel', realArgs);
    const receivedArgs = invoke.mock.calls[0][2];
    expect(receivedArgs).not.toHaveProperty('authInfo');
  });
});
