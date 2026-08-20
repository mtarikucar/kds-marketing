import { McpBrokerService } from '../mcp-broker.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerResearchTools } from './research.tools';
import { registerStrategyTools } from './strategy.tools';
import { registerWorkflowTools } from './workflows.tools';

/**
 * Faz 5 D4 — the approval gate proved on the REAL brain tools through the REAL
 * broker (mirrors `d2-approval-gate.spec.ts`).
 *
 * `mcp-broker.destructive.spec.ts` pins the RULE; this pins the WIRING. The two
 * fail independently and both matter: a correct rule applied to a tool that was
 * registered `risk: 'WRITE'` by a copy-paste is exactly the bug the rule exists
 * to prevent, and no unit test of either half would catch it.
 *
 * The workspace here is AUTONOMOUS — the most permissive mode the product
 * offers — and the assertion that carries the weight is that the underlying
 * SERVICE method was never called: the strategy action was not executed, the
 * research job was not queued, the automation did not enrol a single lead.
 */

const AUTONOMOUS = {
  workspaceId: 'ws1',
  grantedScopes: ['reports.read', 'settings.manage', 'automations.manage'],
  agentRunId: 'run-1',
  requireAudit: true,
  writeMode: 'AUTONOMOUS' as const,
};

// The queue-side of every assertion below: SPEND moved out of the always-gated
// set on 2026-08-12 (owner decision — see mcp-broker.service.ts), so APPROVAL
// mode is now where queuing behavior lives.
const APPROVAL = { ...AUTONOMOUS, writeMode: 'APPROVAL' as const };

function build() {
  const registry = new McpToolRegistry();
  const strategy = {
    getStrategy: jest.fn().mockResolvedValue({ id: 's1' }),
    listActions: jest.fn().mockResolvedValue([{ id: 'a1', status: 'DONE' }]),
    approveAction: jest.fn().mockResolvedValue({ id: 'a1', status: 'APPROVED' }),
    dismissAction: jest.fn().mockResolvedValue({ id: 'a1', status: 'DISMISSED' }),
    setAutonomy: jest.fn().mockResolvedValue({ id: 's1', autonomyLevel: 'SHADOW' }),
  };
  const feedback = { refresh: jest.fn().mockResolvedValue({ strategyId: 's1', actionCount: 3 }) };
  const workflows = {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'w1', status: 'ACTIVE' }),
    create: jest.fn().mockResolvedValue({ id: 'w1', status: 'DRAFT' }),
    setStatus: jest.fn().mockResolvedValue({ id: 'w1', status: 'ACTIVE' }),
  };
  const leadBulk = { bulkEnroll: jest.fn().mockResolvedValue({ queued: 1 }) };
  const research = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'p1' }),
    usage: jest.fn().mockResolvedValue({ remaining: 5 }),
  };
  const runner = { enqueueNow: jest.fn().mockResolvedValue(undefined) };
  const entitlements = {
    getEffective: jest.fn().mockResolvedValue({ features: { workflows: true, research: true } }),
  };

  registerStrategyTools(registry, { strategy, feedback } as never);
  registerWorkflowTools(registry, { workflows, leadBulk, principals: { resolve: jest.fn().mockResolvedValue({ id: 'sys-1' }) }, entitlements } as never);
  registerResearchTools(registry, { research, runner, entitlements } as never);

  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const supersedePending = jest.fn().mockResolvedValue(undefined);
  const broker = new McpBrokerService(
    registry,
    { enqueue, supersedePending } as never,
    { recordTool: jest.fn() } as never,
  );
  return { broker, strategy, feedback, workflows, leadBulk, runner, enqueue, supersedePending };
}

describe("Faz 5 D4 — the brain's SPEND tools: queued in APPROVAL, inline in AUTONOMOUS", () => {
  it('jeeta.approve_strategy_action is QUEUED under APPROVAL — the action is not executed', async () => {
    const { broker, strategy, enqueue } = build();
    const res = await broker.invoke(APPROVAL, 'jeeta.approve_strategy_action', { actionId: 'a1' });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(strategy.approveAction).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        kind: 'STRATEGY_ACTION',
        resourceType: 'strategy_action',
        resourceId: 'a1',
        payload: { tool: 'jeeta.approve_strategy_action', args: { actionId: 'a1' } },
      }),
    );
  });

  it('jeeta.synthesize_strategy is QUEUED under APPROVAL — no credits are reserved', async () => {
    const { broker, feedback, enqueue } = build();
    const res = await broker.invoke(APPROVAL, 'jeeta.synthesize_strategy', {});
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(feedback.refresh).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'AI_SPEND' }));
  });

  it('jeeta.run_research is QUEUED under APPROVAL — no research job is enqueued', async () => {
    const { broker, runner, enqueue } = build();
    const res = await broker.invoke(APPROVAL, 'jeeta.run_research', { profileId: 'p1' });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(runner.enqueueNow).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'AI_SPEND' }));
  });

  it('jeeta.trigger_workflow is QUEUED under APPROVAL — not one lead is enrolled', async () => {
    const { broker, leadBulk, enqueue } = build();
    const res = await broker.invoke(APPROVAL, 'jeeta.trigger_workflow', {
      workflowId: 'w1',
      leadIds: ['l1', 'l2'],
    });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(leadBulk.bulkEnroll).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'SEND' }));
  });

  it('jeeta.approve_strategy_action runs INLINE under AUTONOMOUS — that is what the mode means now', async () => {
    const { broker, strategy, enqueue } = build();
    const res = await broker.invoke(AUTONOMOUS, 'jeeta.approve_strategy_action', { actionId: 'a1' });
    expect(res.status).toBe('OK');
    expect(strategy.approveAction).toHaveBeenCalledWith('ws1', 'a1');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('jeeta.synthesize_strategy runs INLINE under AUTONOMOUS', async () => {
    const { broker, feedback } = build();
    const res = await broker.invoke(AUTONOMOUS, 'jeeta.synthesize_strategy', {});
    expect(res.status).toBe('OK');
    expect(feedback.refresh).toHaveBeenCalledWith('ws1');
  });

  it('the strategy action DOES run once a human approved it (the gate is a queue, not a wall)', async () => {
    const { broker, strategy } = build();
    const res = await broker.invoke(
      { ...AUTONOMOUS, approvedBy: { approvalId: 'appr-1', userId: 'u1' } },
      'jeeta.approve_strategy_action',
      { actionId: 'a1' },
    );
    expect(res.status).toBe('OK');
    expect(strategy.approveAction).toHaveBeenCalledWith('ws1', 'a1');
  });

  /**
   * A re-ask for the SAME action must not leave two identical cards live. The
   * broker supersedes on (kind, resourceType, resourceId), which only works
   * because the tool declares both — pinned here on the real tool.
   */
  it('supersedes a stale pending card for the same strategy action', async () => {
    const { broker, supersedePending } = build();
    await broker.invoke(APPROVAL, 'jeeta.approve_strategy_action', { actionId: 'a1' });
    expect(supersedePending).toHaveBeenCalledWith('ws1', 'STRATEGY_ACTION', 'strategy_action', 'a1');
  });

  it('keeps arming an automation gated in APPROVAL mode, inline in AUTONOMOUS (PUBLISH-class, not SPEND)', async () => {
    const auto = build();
    await auto.broker.invoke(AUTONOMOUS, 'jeeta.set_workflow_enabled', { workflowId: 'w1', enabled: true });
    expect(auto.workflows.setStatus).toHaveBeenCalledWith('ws1', 'w1', 'ACTIVE');

    const approval = build();
    const res = await approval.broker.invoke(
      { ...AUTONOMOUS, writeMode: 'APPROVAL' as never },
      'jeeta.set_workflow_enabled',
      { workflowId: 'w1', enabled: true },
    );
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(approval.workflows.setStatus).not.toHaveBeenCalled();
  });

  it('leaves the D4 reads, drafts and dismissals running inline in both modes', async () => {
    for (const writeMode of ['APPROVAL', 'AUTONOMOUS'] as const) {
      const { broker, strategy, workflows } = build();
      expect((await broker.invoke({ ...AUTONOMOUS, writeMode }, 'jeeta.get_strategy', {})).status).toBe('OK');
      expect(
        (await broker.invoke({ ...AUTONOMOUS, writeMode }, 'jeeta.dismiss_strategy_action', { actionId: 'a1' }))
          .status,
      ).toBe('OK');
      expect(strategy.dismissAction).toHaveBeenCalled();
      expect(
        (
          await broker.invoke({ ...AUTONOMOUS, writeMode }, 'jeeta.create_workflow', {
            name: 'n',
            trigger: { type: 'lead.created' },
            steps: [{ type: 'stop_workflow' }],
          })
        ).status,
      ).toBe('OK');
      expect(workflows.create).toHaveBeenCalled();
    }
  });

  /**
   * The escalation test, end to end through the broker: even in the most
   * permissive mode, with every scope granted and with a human approval already
   * attached, `AUTONOMOUS` cannot be written to the strategy lane. The refusal
   * is the schema, so there is no path — approved or not — that reaches
   * `setAutonomy` with it.
   */
  it('cannot arm the fully autonomous strategy lane even WITH a human approval attached', async () => {
    const { broker, strategy } = build();
    await expect(
      broker.invoke(
        { ...AUTONOMOUS, approvedBy: { approvalId: 'appr-1', userId: 'u1' } },
        'jeeta.set_strategy_autonomy',
        { level: 'AUTONOMOUS' },
      ),
      // The broker now enforces the schema before the handler, so the refusal
      // names the field and the values it does allow ("SHADOW"|"ASSISTED")
      // rather than echoing the rejected one. Earlier refusal, same guarantee —
      // and the assertion that matters is the next line.
    ).rejects.toThrow(/level/);
    expect(strategy.setAutonomy).not.toHaveBeenCalled();
  });
});
