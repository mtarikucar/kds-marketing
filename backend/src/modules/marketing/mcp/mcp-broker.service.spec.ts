import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool } from './mcp-tool-registry';

function deps() {
  const registry = new McpToolRegistry();
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const supersedePending = jest.fn().mockResolvedValue(undefined);
  const recordTool = jest.fn().mockResolvedValue(undefined);
  const approvals = { enqueue, supersedePending } as any;
  const runs = { recordTool } as any;
  const broker = new McpBrokerService(registry, approvals, runs);
  return { registry, broker, enqueue, supersedePending, recordTool };
}

const readTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.get_campaign_performance',
  description: 'read perf',
  scopes: ['reports.read'],
  risk: 'READ',
  requiresApproval: false,
  inputSchema: z.object({}),
  handler,
});

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

const sendTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.send_message',
  description: 'send a reply',
  scopes: ['contacts.write'],
  risk: 'WRITE',
  requiresApproval: true,
  approvalKind: 'SEND',
  resourceType: 'conversation',
  resourceIdFrom: (args) => (typeof args.conversationId === 'string' ? args.conversationId : undefined),
  inputSchema: z.object({ conversationId: z.string(), body: z.string() }),
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

  // M1: an MCP approval must carry an expiry — decide()'s expiry guard is
  // otherwise dead for this lane and a request approved weeks later still
  // fires.
  it('sets an expiresAt on every enqueued MCP approval request', async () => {
    const { registry, broker, enqueue } = deps();
    registry.register(spendTool(jest.fn()));
    const before = Date.now();
    await broker.invoke(ctx(['settings.manage'], 'run-1'), 'jeeta.reallocate_budget', { amount: 500 });
    const arg = enqueue.mock.calls[0][1];
    expect(arg.expiresAt).toBeInstanceOf(Date);
    expect(arg.expiresAt.getTime()).toBeGreaterThan(before);
    expect(arg.expiresAt.getTime()).toBeLessThanOrEqual(before + 24 * 60 * 60 * 1000 + 1000);
  });

  // H2: a tool that declares resourceType/resourceIdFrom gets a
  // resourceType/resourceId on the enqueued row, AND any still-PENDING
  // duplicate for the same target is superseded first — so a user re-asking
  // (or a transport retry) never leaves two live cards for the same send.
  describe('H2 — dedupe (resourceType/resourceId + supersede)', () => {
    it('carries resourceType/resourceId from the tool onto the enqueued request', async () => {
      const { registry, broker, enqueue } = deps();
      registry.register(sendTool(jest.fn()));
      await broker.invoke(ctx(['contacts.write'], 'run-1'), 'jeeta.send_message', { conversationId: 'c1', body: 'hi' });
      expect(enqueue).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({ resourceType: 'conversation', resourceId: 'c1' }),
      );
    });

    it('supersedes a prior PENDING duplicate for the same (kind, resourceType, resourceId) before enqueueing the new one', async () => {
      const { registry, broker, enqueue, supersedePending } = deps();
      registry.register(sendTool(jest.fn()));
      const calls: string[] = [];
      supersedePending.mockImplementation(async () => {
        calls.push('supersede');
      });
      enqueue.mockImplementation(async () => {
        calls.push('enqueue');
        return { id: 'appr-2' };
      });

      await broker.invoke(ctx(['contacts.write'], 'run-1'), 'jeeta.send_message', { conversationId: 'c1', body: 'hi again' });

      expect(supersedePending).toHaveBeenCalledWith('ws1', 'SEND', 'conversation', 'c1');
      expect(calls).toEqual(['supersede', 'enqueue']); // superseded BEFORE the new one lands
    });

    it('does not call supersedePending for a tool with no resourceType/resourceIdFrom (no dedupe key)', async () => {
      const { registry, broker, supersedePending, enqueue } = deps();
      registry.register(spendTool(jest.fn())); // no resourceType declared
      await broker.invoke(ctx(['settings.manage'], 'run-1'), 'jeeta.reallocate_budget', { amount: 500 });
      expect(supersedePending).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalled();
    });

    it('does not call supersedePending when resourceIdFrom cannot resolve an id from the given args', async () => {
      const { registry, broker, supersedePending } = deps();
      registry.register(sendTool(jest.fn()));
      await broker.invoke(ctx(['contacts.write'], 'run-1'), 'jeeta.send_message', { body: 'hi' }); // no conversationId
      expect(supersedePending).not.toHaveBeenCalled();
    });
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
