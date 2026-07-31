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

/**
 * A risky-but-RECOVERABLE tool: it reaches a real audience, so it is
 * approval-gated by default, but a bad one can be seen and corrected. This is
 * the class AUTONOMOUS mode exists for. Before Faz 5 D2 this spec used the
 * SPEND tool above for the AUTONOMOUS cases; the design spec (§4) puts SPEND
 * and DESTRUCTIVE outside the bypass, so those moved to
 * mcp-broker.destructive.spec.ts and this is what "risky" means here now.
 */
const publishTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.publish_thing',
  description: 'publish',
  scopes: ['settings.manage'],
  risk: 'WRITE',
  requiresApproval: true,
  approvalKind: 'PUBLISH',
  inputSchema: z.object({ amount: z.number().optional() }),
  handler,
});

const ctx = (writeMode?: 'APPROVAL' | 'AUTONOMOUS') => ({
  workspaceId: 'ws1',
  grantedScopes: ['settings.manage'],
  agentRunId: 'run-1',
  requireAudit: true,
  writeMode,
});

describe('McpBrokerService write mode', () => {
  it('queues a risky tool in APPROVAL mode', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn();
    registry.register(spendTool(handler));
    const res = await broker.invoke(ctx('APPROVAL'), 'jeeta.reallocate_budget', { amount: 100 });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes a risky tool inline in AUTONOMOUS mode', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn().mockResolvedValue({ moved: 100 });
    registry.register(publishTool(handler));
    const res = await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.publish_thing', { amount: 100 });
    expect(res).toEqual({ status: 'OK', result: { moved: 100 } });
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('still writes the audit log in AUTONOMOUS mode', async () => {
    const { registry, broker, recordTool } = deps();
    registry.register(publishTool(jest.fn().mockResolvedValue({ moved: 100 })));
    await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.publish_thing', { amount: 100 });
    expect(recordTool).toHaveBeenCalled();
  });

  it('does NOT extend the AUTONOMOUS bypass to a SPEND tool (design spec §4)', async () => {
    // Money is the one thing an audit log cannot undo. See
    // mcp-broker.destructive.spec.ts for the full both-directions matrix.
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn();
    registry.register(spendTool(handler));
    const res = await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.reallocate_budget', { amount: 100 });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('defaults to queuing when write mode is unset', async () => {
    const { registry, broker, enqueue } = deps();
    registry.register(spendTool(jest.fn()));
    const res = await broker.invoke(ctx(), 'jeeta.reallocate_budget', {});
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
  });
});
