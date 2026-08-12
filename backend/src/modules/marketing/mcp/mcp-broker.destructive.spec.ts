import { z } from 'zod';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool, ToolRisk } from './mcp-tool-registry';

/**
 * The `DESTRUCTIVE` risk class and the "no mode bypasses deletion" rule.
 *
 * The current risk table for an AUTONOMOUS workspace:
 *
 *   READ / WRITE / SEND / PUBLISH / SPEND → run (audited)
 *   DESTRUCTIVE                           → **approval in every mode**
 *
 * SPEND sat in the always-gated row from D2 until 2026-08-12, when the owner
 * moved it out: gating every synthesis/research/generation made AUTONOMOUS
 * meaningless for the flows an agent exists for, and spend — unlike deletion —
 * is bounded by the workspace's own metered credits and wallet. Deletion keeps
 * the unconditional gate: no undo table, no balance to bound it. These tests
 * pin the rule from both sides.
 */

function deps() {
  const registry = new McpToolRegistry();
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const supersedePending = jest.fn().mockResolvedValue(undefined);
  const recordTool = jest.fn().mockResolvedValue(undefined);
  return {
    registry,
    broker: new McpBrokerService(
      registry,
      { enqueue, supersedePending } as any,
      { recordTool } as any,
    ),
    enqueue,
    supersedePending,
    recordTool,
  };
}

const toolWith = (risk: ToolRisk, handler: jest.Mock, extra: Partial<McpTool> = {}): McpTool => ({
  name: 'jeeta.some_tool',
  description: 'a tool',
  domain: 'workspace',
  scopes: ['campaigns.write'],
  risk,
  requiresApproval: true,
  inputSchema: z.object({ postId: z.string().optional() }),
  handler,
  ...extra,
});

const ctx = (writeMode?: 'APPROVAL' | 'AUTONOMOUS') => ({
  workspaceId: 'ws1',
  grantedScopes: ['campaigns.write'],
  agentRunId: 'run-1',
  requireAudit: true,
  writeMode,
});

describe('McpBrokerService — DESTRUCTIVE is never bypassable; SPEND queues only in APPROVAL', () => {
  it.each<[ToolRisk]>([['DESTRUCTIVE'], ['SPEND']])(
    'queues a %s tool in APPROVAL mode',
    async (risk) => {
      const { registry, broker, enqueue } = deps();
      const handler = jest.fn();
      registry.register(toolWith(risk, handler));
      const res = await broker.invoke(ctx('APPROVAL'), 'jeeta.some_tool', {});
      expect(res.status).toBe('PENDING_APPROVAL');
      expect(enqueue).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('STILL queues a DESTRUCTIVE tool in AUTONOMOUS mode — autonomy does not buy a delete', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn();
    registry.register(toolWith('DESTRUCTIVE', handler));
    const res = await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.some_tool', {});
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(res.approvalId).toBe('appr-1');
    expect(enqueue).toHaveBeenCalled();
    // The only assertion that actually matters: the side effect never ran.
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs a SPEND tool inline in AUTONOMOUS mode — spend is bounded by the workspace balances', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registry.register(toolWith('SPEND', handler));
    const res = await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.some_tool', {});
    expect(res.status).toBe('OK');
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('supersedes a stale pending request for the same DESTRUCTIVE target under AUTONOMOUS too', async () => {
    const { registry, broker, supersedePending } = deps();
    registry.register(
      toolWith('DESTRUCTIVE', jest.fn(), {
        approvalKind: 'DESTRUCTIVE',
        resourceType: 'social_post',
        resourceIdFrom: (args) => (typeof args.postId === 'string' ? args.postId : undefined),
      }),
    );
    await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.some_tool', { postId: 'p1' });
    expect(supersedePending).toHaveBeenCalledWith('ws1', 'DESTRUCTIVE', 'social_post', 'p1');
  });

  it('executes a DESTRUCTIVE tool once a human has approved it (the approve → apply capstone still works)', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn().mockResolvedValue({ deleted: true });
    registry.register(toolWith('DESTRUCTIVE', handler));
    const res = await broker.invoke(
      { ...ctx('APPROVAL'), approvedBy: { approvalId: 'appr-1', userId: 'u1' } },
      'jeeta.some_tool',
      {},
    );
    expect(res).toEqual({ status: 'OK', result: { deleted: true } });
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it.each<[ToolRisk]>([['READ'], ['WRITE']])(
    'leaves the AUTONOMOUS bypass intact for a %s-risk tool (PUBLISH/SEND lane)',
    async (risk) => {
      const { registry, broker, enqueue } = deps();
      const handler = jest.fn().mockResolvedValue({ published: true });
      registry.register(toolWith(risk, handler, { approvalKind: 'PUBLISH' }));
      const res = await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.some_tool', {});
      expect(res).toEqual({ status: 'OK', result: { published: true } });
      expect(enqueue).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalled();
    },
  );

  it('audits a DESTRUCTIVE execution like any other', async () => {
    const { registry, broker, recordTool } = deps();
    registry.register(toolWith('DESTRUCTIVE', jest.fn().mockResolvedValue({ deleted: true })));
    await broker.invoke(
      { ...ctx('AUTONOMOUS'), approvedBy: { approvalId: 'a', userId: 'u1' } },
      'jeeta.some_tool',
      {},
    );
    expect(recordTool).toHaveBeenCalledWith(
      'ws1',
      'run-1',
      expect.objectContaining({ tool: 'jeeta.some_tool', ok: true }),
    );
  });
});
