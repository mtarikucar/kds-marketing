import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool } from './mcp-tool-registry';

function deps() {
  const registry = new McpToolRegistry();
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const recordTool = jest.fn().mockResolvedValue(undefined);
  const approvals = { enqueue } as any;
  const runs = { recordTool } as any;
  const broker = new McpBrokerService(registry, approvals, runs);
  return { registry, broker, enqueue, recordTool };
}

const readTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.get_campaign_performance',
  description: 'read perf',
  scopes: ['reports.read'],
  risk: 'READ',
  requiresApproval: false,
  handler,
});

const spendTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.reallocate_budget',
  description: 'move budget',
  scopes: ['settings.manage'],
  risk: 'SPEND',
  requiresApproval: true,
  approvalKind: 'BUDGET_REALLOCATION',
  handler,
});

const ctx = (scopes: string[], agentRunId?: string) => ({ workspaceId: 'ws1', grantedScopes: scopes, agentRunId });

describe('McpBrokerService', () => {
  it('denies unknown tools (deny-by-default)', async () => {
    const { broker } = deps();
    await expect(broker.invoke(ctx(['reports.read']), 'jeeta.nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enforces per-tenant scope (least privilege)', async () => {
    const { registry, broker } = deps();
    const h = jest.fn();
    registry.register(readTool(h));
    await expect(broker.invoke(ctx([]), 'jeeta.get_campaign_performance')).rejects.toBeInstanceOf(ForbiddenException);
    expect(h).not.toHaveBeenCalled();
  });

  it('executes a permitted read tool and logs a tool call', async () => {
    const { registry, broker, recordTool } = deps();
    const h = jest.fn().mockResolvedValue({ cpl: 12 });
    registry.register(readTool(h));
    const r = await broker.invoke(ctx(['reports.read'], 'run-1'), 'jeeta.get_campaign_performance', { id: 'c1' });
    expect(r).toMatchObject({ status: 'OK', result: { cpl: 12 } });
    expect(h).toHaveBeenCalled();
    expect(recordTool).toHaveBeenCalledWith('ws1', 'run-1', expect.objectContaining({ tool: 'jeeta.get_campaign_performance', ok: true }));
  });

  it('NEVER executes a high-risk tool inline — it enqueues an approval', async () => {
    const { registry, broker, enqueue } = deps();
    const h = jest.fn();
    registry.register(spendTool(h));
    const r = await broker.invoke(ctx(['settings.manage'], 'run-1'), 'jeeta.reallocate_budget', { amount: 500 });
    expect(r).toEqual({ status: 'PENDING_APPROVAL', approvalId: 'appr-1' });
    expect(h).not.toHaveBeenCalled(); // no execution
    expect(enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'BUDGET_REALLOCATION' }));
  });

  it('rejects oversized arguments', async () => {
    const { registry, broker } = deps();
    registry.register(readTool(jest.fn()));
    const big = { blob: 'x'.repeat(40 * 1024) };
    await expect(broker.invoke(ctx(['reports.read']), 'jeeta.get_campaign_performance', big)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('logs a failed tool call and re-throws', async () => {
    const { registry, broker, recordTool } = deps();
    const h = jest.fn().mockRejectedValue(new Error('boom'));
    registry.register(readTool(h));
    await expect(broker.invoke(ctx(['reports.read'], 'run-1'), 'jeeta.get_campaign_performance')).rejects.toThrow('boom');
    expect(recordTool).toHaveBeenCalledWith('ws1', 'run-1', expect.objectContaining({ ok: false, error: 'boom' }));
  });

  it('list() hides tools the caller lacks scope for', () => {
    const { registry } = deps();
    registry.register(readTool(jest.fn()));
    registry.register(spendTool(jest.fn()));
    expect(registry.list(['reports.read']).map((t) => t.name)).toEqual(['jeeta.get_campaign_performance']);
    expect(registry.list(['reports.read', 'settings.manage'])).toHaveLength(2);
  });
});
