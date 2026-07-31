import { McpToolRegistry } from '../mcp-tool-registry';
import { registerStrategyTools, StrategyToolDeps } from './strategy.tools';

function build(overrides: Partial<Record<string, unknown>> = {}) {
  const strategy = {
    getStrategy: jest.fn().mockResolvedValue({ id: 's1', archetype: 'B2B_SAAS', autonomyLevel: 'ASSISTED' }),
    listActions: jest.fn().mockResolvedValue([{ id: 'a1', kind: 'CONTENT', status: 'PROPOSED' }]),
    approveAction: jest.fn().mockResolvedValue({ id: 'a1', status: 'APPROVED', resultRef: null }),
    dismissAction: jest.fn().mockResolvedValue({ id: 'a1', status: 'DISMISSED' }),
    setAutonomy: jest.fn().mockResolvedValue({ id: 's1', autonomyLevel: 'SHADOW' }),
    ...overrides,
  };
  const feedback = { refresh: jest.fn().mockResolvedValue({ strategyId: 's1', actionCount: 4 }) };
  const registry = new McpToolRegistry();
  registerStrategyTools(registry, { strategy, feedback } as unknown as StrategyToolDeps);
  return { registry, strategy, feedback };
}

const CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };

describe('Faz 5 D4 — strategy MCP tools', () => {
  it('registers exactly the six strategy tools, all in the strategy domain', () => {
    const { registry } = build();
    const names = registry
      .list(['reports.read', 'settings.manage'])
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        'jeeta.get_strategy',
        'jeeta.list_strategy_actions',
        'jeeta.approve_strategy_action',
        'jeeta.dismiss_strategy_action',
        'jeeta.synthesize_strategy',
        'jeeta.set_strategy_autonomy',
      ].sort(),
    );
    for (const name of names) expect(registry.get(name)!.domain).toBe('strategy');
  });

  it('reads the active brief through StrategyService.getStrategy', async () => {
    const { registry, strategy } = build();
    const out = await registry.get('jeeta.get_strategy')!.handler(CTX, {});
    expect(strategy.getStrategy).toHaveBeenCalledWith('ws1');
    expect(out).toMatchObject({ archetype: 'B2B_SAAS' });
  });

  it('explains itself rather than returning a bare null when no strategy exists yet', async () => {
    const { registry } = build({ getStrategy: jest.fn().mockResolvedValue(null) });
    const out = (await registry.get('jeeta.get_strategy')!.handler(CTX, {})) as { strategy: null; message: string };
    expect(out.strategy).toBeNull();
    expect(out.message).toMatch(/interview/i);
  });

  it('filters the ActionPlan by status', async () => {
    const { registry, strategy } = build();
    await registry.get('jeeta.list_strategy_actions')!.handler(CTX, { status: 'PROPOSED' });
    expect(strategy.listActions).toHaveBeenCalledWith('ws1', { status: 'PROPOSED' });
  });

  /**
   * `StrategyService.approveAction` snapshots the row BEFORE handing it to the
   * orchestrator, so its return value always says `APPROVED` / `resultRef:
   * null` even when the executor has since failed. Reporting that to an agent
   * as the outcome is a lie it will relay to the user.
   */
  it('re-reads the action after approval so the reported outcome is the real one', async () => {
    const { registry, strategy } = build();
    strategy.listActions.mockResolvedValue([
      { id: 'a1', kind: 'COMMUNITY_ENGAGE', status: 'FAILED', resultRef: 'error:discord 403' },
    ]);
    const out = (await registry.get('jeeta.approve_strategy_action')!.handler(CTX, { actionId: 'a1' })) as {
      status: string;
      resultRef: string | null;
    };
    expect(strategy.approveAction).toHaveBeenCalledWith('ws1', 'a1');
    expect(out.status).toBe('FAILED');
    expect(out.resultRef).toBe('error:discord 403');
  });

  it('falls back to the approval row if the action can no longer be re-read', async () => {
    const { registry, strategy } = build();
    strategy.listActions.mockResolvedValue([]);
    const out = (await registry.get('jeeta.approve_strategy_action')!.handler(CTX, { actionId: 'a1' })) as {
      status: string;
    };
    expect(out.status).toBe('APPROVED');
  });

  it('dismisses through the service', async () => {
    const { registry, strategy } = build();
    await registry.get('jeeta.dismiss_strategy_action')!.handler(CTX, { actionId: 'a1' });
    expect(strategy.dismissAction).toHaveBeenCalledWith('ws1', 'a1');
  });

  /**
   * Re-synthesis must go through the FEEDBACK service, not
   * `StrategySynthesisService.synthesize` directly: `refresh` is the only
   * caller that resolves the workspace's intake session and folds the previous
   * plan's OUTCOMES back in. Calling synthesize() from here would need an
   * intake session id an agent has no way to obtain.
   */
  it('re-synthesizes through StrategyFeedbackService.refresh (credits metered inside)', async () => {
    const { registry, feedback } = build();
    const out = await registry.get('jeeta.synthesize_strategy')!.handler(CTX, {});
    expect(feedback.refresh).toHaveBeenCalledWith('ws1');
    expect(out).toEqual({ strategyId: 's1', actionCount: 4 });
  });

  describe('risk classification (spec §4)', () => {
    it('classifies approve_strategy_action as SPEND — approving EXECUTES the action', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.approve_strategy_action')!;
      expect(tool.risk).toBe('SPEND');
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('STRATEGY_ACTION');
      expect(tool.resourceType).toBe('strategy_action');
      expect(tool.resourceIdFrom!({ actionId: 'a1' })).toBe('a1');
    });

    it('classifies synthesize_strategy as SPEND — it burns AI credits and scraping money', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.synthesize_strategy')!;
      expect(tool.risk).toBe('SPEND');
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('AI_SPEND');
    });

    it('leaves the two reads and the dismiss unattended', () => {
      const { registry } = build();
      expect(registry.get('jeeta.get_strategy')!.requiresApproval).toBe(false);
      expect(registry.get('jeeta.list_strategy_actions')!.requiresApproval).toBe(false);
      // Dismissing only ever REMOVES an action from the plan — the safe
      // direction. Gating it would mean an agent can propose but not tidy up.
      expect(registry.get('jeeta.dismiss_strategy_action')!.requiresApproval).toBe(false);
      expect(registry.get('jeeta.dismiss_strategy_action')!.risk).toBe('WRITE');
    });

    it('demands the same permissions the panel does: reports.read to read, settings.manage to decide', () => {
      const { registry } = build();
      expect(registry.get('jeeta.get_strategy')!.scopes).toEqual(['reports.read']);
      expect(registry.get('jeeta.list_strategy_actions')!.scopes).toEqual(['reports.read']);
      for (const n of [
        'jeeta.approve_strategy_action',
        'jeeta.dismiss_strategy_action',
        'jeeta.synthesize_strategy',
        'jeeta.set_strategy_autonomy',
      ]) {
        expect(registry.get(n)!.scopes).toEqual(['settings.manage']);
      }
    });
  });

  /**
   * THE privilege-escalation guard of this wave. `AUTONOMOUS` removes the human
   * gate from the strategy lane entirely — an agent that could set it would be
   * widening its own authority. The refusal is STRUCTURAL: the value is not in
   * the schema at all, so no write mode, no approved replay and no future
   * `requiresApproval` regression can let it through.
   */
  describe('set_strategy_autonomy cannot self-grant AUTONOMOUS', () => {
    it('does not accept AUTONOMOUS as a value at all', () => {
      const { registry } = build();
      const schema = registry.get('jeeta.set_strategy_autonomy')!.inputSchema as {
        parse: (v: unknown) => unknown;
      };
      expect(() => schema.parse({ level: 'AUTONOMOUS' })).toThrow();
      expect(() => schema.parse({ level: 'SHADOW' })).not.toThrow();
      expect(() => schema.parse({ level: 'ASSISTED' })).not.toThrow();
    });

    it('never reaches the service with AUTONOMOUS even if the schema were bypassed', async () => {
      const { registry, strategy } = build();
      await expect(
        registry.get('jeeta.set_strategy_autonomy')!.handler(CTX, { level: 'AUTONOMOUS' }),
      ).rejects.toThrow(/AUTONOMOUS/);
      expect(strategy.setAutonomy).not.toHaveBeenCalled();
    });

    it('passes the human-gated lanes straight through', async () => {
      const { registry, strategy } = build();
      await registry.get('jeeta.set_strategy_autonomy')!.handler(CTX, { level: 'SHADOW' });
      expect(strategy.setAutonomy).toHaveBeenCalledWith('ws1', 'SHADOW');
    });

    it('is additionally approval-gated, and says why in its description', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.set_strategy_autonomy')!;
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('TARGET_CHANGE');
      expect(tool.description).toMatch(/autonomous/i);
    });
  });
});
