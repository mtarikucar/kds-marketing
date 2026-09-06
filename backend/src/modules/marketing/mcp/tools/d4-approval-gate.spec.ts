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
  const synthesis = {
    submitStrategy: jest.fn().mockResolvedValue({ strategyId: 's1', actionCount: 1, droppedActions: 0 }),
  };
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

  registerStrategyTools(registry, { strategy, feedback, synthesis } as never);
  registerWorkflowTools(registry, { workflows, leadBulk, principals: { resolve: jest.fn().mockResolvedValue({ id: 'sys-1' }) }, entitlements } as never);
  registerResearchTools(registry, { research, runner, entitlements } as never);

  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const supersedePending = jest.fn().mockResolvedValue(undefined);
  const broker = new McpBrokerService(
    registry,
    { enqueue, supersedePending } as never,
    { recordTool: jest.fn() } as never,
  );
  return { broker, strategy, feedback, synthesis, workflows, leadBulk, runner, enqueue, supersedePending };
}

/** A submission the tool's own schema accepts — the broker `safeParse`s before
 *  it reaches the handler, so an invalid fixture would fail these tests for the
 *  wrong reason. */
const SUBMISSION = {
  archetype: 'B2C_COMMUNITY_NICHE',
  brief: {
    identity: {
      product: 'Private Metin2 server',
      voice: 'playful, nostalgic',
      positioning: 'The classic-era server',
      usp: 'Pre-2010 mechanics',
    },
    audience: 'Nostalgic Metin2 veterans, 20-35, EU',
    channels: [{ key: 'reddit', fitScore: 0.9, rationale: 'r/Metin2 is where they gather' }],
    contentPillars: [{ title: 'Classic-era clips', angle: 'nostalgia', formats: ['reel'], tone: 'playful' }],
    goals: { objective: 'Grow active players to 2k', kpis: ['DAU'] },
    budget: 'Bootstrap: organic + $200/mo ads',
    competitors: ['OtherServer.gg'],
  },
  actions: [
    { kind: 'COMMUNITY_ENGAGE', title: 'Post in r/Metin2', rationale: 'Where the audience is', priority: 'HIGH' },
  ],
};

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
   * `jeeta.submit_strategy` — a WRITE-classified, ungated tool in the SPEND
   * domain this file guards, which makes it exactly the subject of the note at
   * the top: "a tool that was registered `risk: 'WRITE'` by a copy-paste".
   *
   * Here the classification is deliberate, so these assert what IS true of it
   * rather than that it is gated. It runs inline in BOTH write modes, on
   * purpose — a gated one could not close the readiness gap that names it — and
   * the guarantee that makes that acceptable is not a broker gate at all: it
   * writes a plan of PROPOSED actions and dispatches none of them. Moving one
   * is the SEPARATE, SPEND-classified `approve_strategy_action` tested above.
   */
  describe('jeeta.submit_strategy — WRITE and ungated, deliberately', () => {
    it('runs inline in BOTH write modes and queues nothing', async () => {
      for (const writeMode of ['APPROVAL', 'AUTONOMOUS'] as const) {
        const { broker, synthesis, enqueue } = build();
        const res = await broker.invoke({ ...AUTONOMOUS, writeMode }, 'jeeta.submit_strategy', SUBMISSION);
        expect({ writeMode, status: res.status }).toEqual({ writeMode, status: 'OK' });
        expect(synthesis.submitStrategy).toHaveBeenCalledWith('ws1', {
          archetype: SUBMISSION.archetype,
          brief: SUBMISSION.brief,
          actions: SUBMISSION.actions,
        });
        expect(enqueue).not.toHaveBeenCalled();
      }
    });

    /**
     * The reason it is allowed to be ungated. Writing a strategy dispatches
     * nothing: no action is approved, no research job queued, nothing published
     * — which is the same assertion this file makes about the gated tools,
     * here made about an UNgated one.
     */
    it('executes no action of the plan it just wrote, in either mode', async () => {
      for (const writeMode of ['APPROVAL', 'AUTONOMOUS'] as const) {
        const { broker, strategy, feedback, runner, leadBulk } = build();
        await broker.invoke({ ...AUTONOMOUS, writeMode }, 'jeeta.submit_strategy', SUBMISSION);
        expect(strategy.approveAction).not.toHaveBeenCalled();
        expect(strategy.setAutonomy).not.toHaveBeenCalled();
        expect(feedback.refresh).not.toHaveBeenCalled();
        expect(runner.enqueueNow).not.toHaveBeenCalled();
        expect(leadBulk.bulkEnroll).not.toHaveBeenCalled();
      }
    });

    /**
     * And the corollary worth stating out loud: because nothing in the broker
     * gates a WRITE tool, NOTHING IN THE BROKER protects an existing strategy
     * from being overwritten either. That protection is the service's — a
     * `create` against `MarketingStrategy.workspaceId @unique` — and what
     * arrives here is its refusal, propagated as an error rather than softened
     * into a PENDING_APPROVAL card.
     */
    it('propagates the service refusal — the broker is not what protects an existing strategy', async () => {
      const { broker, synthesis, enqueue } = build();
      synthesis.submitStrategy.mockRejectedValue(new Error('This workspace already has a strategy (v3, ACTIVE).'));
      await expect(broker.invoke(AUTONOMOUS, 'jeeta.submit_strategy', SUBMISSION)).rejects.toThrow(
        /already has a strategy/,
      );
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('is reachable only with settings.manage, like the rest of the strategy writes', async () => {
      const { broker, synthesis } = build();
      await expect(
        broker.invoke({ ...AUTONOMOUS, grantedScopes: ['reports.read'] }, 'jeeta.submit_strategy', SUBMISSION),
      ).rejects.toThrow();
      expect(synthesis.submitStrategy).not.toHaveBeenCalled();
    });
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
