import { ForbiddenException } from '@nestjs/common';
import { McpToolRegistry } from './mcp-tool-registry';
import { McpServerFactoryService } from './mcp-server.factory';
import type { AuthInfo } from '@modelcontextprotocol/server';

const authInfo = (scopes: string[]): AuthInfo =>
  ({ token: 't', clientId: 'k1', scopes, expiresAt: Math.floor(Date.now() / 1000) + 60, extra: { workspaceId: 'ws1' } }) as AuthInfo;

function deps() {
  const registry = new McpToolRegistry();
  registry.register({
    name: 'jeeta.get_funnel',
    description: 'funnel',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
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
  });

  it('refuses to build without authInfo', () => {
    const { factory } = deps();
    expect(() => factory.build({ era: 'modern' } as any)).toThrow(/auth/i);
  });

  it('exposes no tools to a caller lacking the scope', () => {
    const { factory, registry } = deps();
    expect(registry.list(['leads.read'])).toHaveLength(0);
    expect(() => factory.build({ era: 'modern', authInfo: authInfo(['leads.read']) } as any)).not.toThrow();
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
