import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool } from './mcp-tool-registry';

function deps() {
  const registry = new McpToolRegistry();
  const approvals = { enqueue: jest.fn().mockResolvedValue({ id: 'appr-1' }) } as any;
  const runs = { recordTool: jest.fn().mockResolvedValue(undefined) } as any;
  return { registry, broker: new McpBrokerService(registry, approvals, runs), runs };
}

const tool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.get_funnel',
  description: 'read funnel',
  scopes: ['reports.read'],
  risk: 'READ',
  requiresApproval: false,
  inputSchema: z.object({}),
  handler,
});

describe('McpBrokerService audit enforcement', () => {
  it('rejects an auditable call that carries no agentRunId', async () => {
    const { registry, broker } = deps();
    const handler = jest.fn();
    registry.register(tool(handler));
    await expect(
      broker.invoke({ workspaceId: 'ws1', grantedScopes: ['reports.read'], requireAudit: true }, 'jeeta.get_funnel'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes and logs when an agentRunId is present', async () => {
    const { registry, broker, runs } = deps();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registry.register(tool(handler));
    const res = await broker.invoke(
      { workspaceId: 'ws1', grantedScopes: ['reports.read'], agentRunId: 'run-1', requireAudit: true },
      'jeeta.get_funnel',
    );
    expect(res).toEqual({ status: 'OK', result: { ok: true } });
    expect(runs.recordTool).toHaveBeenCalled();
  });

  it('leaves non-auditable callers untouched (back-compat)', async () => {
    const { registry, broker } = deps();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registry.register(tool(handler));
    await expect(
      broker.invoke({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, 'jeeta.get_funnel'),
    ).resolves.toEqual({ status: 'OK', result: { ok: true } });
  });
});
