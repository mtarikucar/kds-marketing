import { z } from 'zod';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool, ToolRisk } from './mcp-tool-registry';

/**
 * Faz 5 D2 — the `DESTRUCTIVE` risk class and the "no mode bypasses money or
 * deletion" rule (design spec §4).
 *
 * The spec's risk table is explicit about which classes an AUTONOMOUS
 * workspace may run unattended:
 *
 *   READ / WRITE / SEND / PUBLISH → run (audited)
 *   SPEND / DESTRUCTIVE          → **approval in every mode**
 *
 * Before D2 the broker had a single gate — `requiresApproval && writeMode !==
 * 'AUTONOMOUS'` — so flipping a workspace to AUTONOMOUS let an agent spend
 * money and (once D2 shipped delete tools) permanently remove rows with no
 * human in the loop. These tests pin the corrected rule from both sides: the
 * always-gated classes stay queued under AUTONOMOUS, and the merely-risky
 * classes keep executing inline exactly as they did (that is what AUTONOMOUS
 * is FOR — see mcp-broker.writemode.spec.ts).
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

describe('McpBrokerService — DESTRUCTIVE + SPEND are never bypassable', () => {
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

  it.each<[ToolRisk]>([['DESTRUCTIVE'], ['SPEND']])(
    'STILL queues a %s tool in AUTONOMOUS mode — autonomy does not buy a bypass',
    async (risk) => {
      const { registry, broker, enqueue } = deps();
      const handler = jest.fn();
      registry.register(toolWith(risk, handler));
      const res = await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.some_tool', {});
      expect(res.status).toBe('PENDING_APPROVAL');
      expect(res.approvalId).toBe('appr-1');
      expect(enqueue).toHaveBeenCalled();
      // The only assertion that actually matters: the side effect never ran.
      expect(handler).not.toHaveBeenCalled();
    },
  );

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
