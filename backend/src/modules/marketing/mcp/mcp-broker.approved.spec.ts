import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool } from './mcp-tool-registry';

function deps() {
  const registry = new McpToolRegistry();
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const recordTool = jest.fn().mockResolvedValue(undefined);
  return { registry, broker: new McpBrokerService(registry, { enqueue } as any, { recordTool } as any), enqueue, recordTool };
}

const spendTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.reallocate_budget',
  description: 'move budget',
  scopes: ['settings.manage'],
  risk: 'SPEND',
  requiresApproval: true,
  approvalKind: 'BUDGET_REALLOCATION',
  inputSchema: z.object({ amount: z.number().optional() }),
  handler,
});

const ctx = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'ws1',
  grantedScopes: ['settings.manage'],
  agentRunId: 'run-1',
  requireAudit: true,
  ...overrides,
});

describe('McpBrokerService approved execution', () => {
  it('executes a requiresApproval tool inline when approvedBy is set', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn().mockResolvedValue({ moved: 100 });
    registry.register(spendTool(handler));
    const res = await broker.invoke(
      ctx({ approvedBy: { approvalId: 'appr-1', userId: 'user-1' } }),
      'jeeta.reallocate_budget',
      { amount: 100 },
    );
    expect(res).toEqual({ status: 'OK', result: { moved: 100 } });
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('still writes the audit log for an approved execution', async () => {
    const { registry, broker, recordTool } = deps();
    registry.register(spendTool(jest.fn().mockResolvedValue({ moved: 100 })));
    await broker.invoke(
      ctx({ approvedBy: { approvalId: 'appr-1', userId: 'user-1' } }),
      'jeeta.reallocate_budget',
      { amount: 100 },
    );
    expect(recordTool).toHaveBeenCalled();
  });

  it('still refuses approvedBy calls missing agentRunId (audit guard holds)', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn();
    registry.register(spendTool(handler));
    await expect(
      broker.invoke(
        ctx({ agentRunId: undefined, approvedBy: { approvalId: 'appr-1', userId: 'user-1' } }),
        'jeeta.reallocate_budget',
        { amount: 100 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(handler).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still enqueues when neither approvedBy nor AUTONOMOUS is set', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn();
    registry.register(spendTool(handler));
    const res = await broker.invoke(ctx(), 'jeeta.reallocate_budget', { amount: 100 });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
