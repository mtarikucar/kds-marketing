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
  const synthesis = {
    submitStrategy: jest.fn().mockResolvedValue({ strategyId: 's1', actionCount: 2, droppedActions: 0 }),
  };
  const registry = new McpToolRegistry();
  registerStrategyTools(registry, { strategy, feedback, synthesis } as unknown as StrategyToolDeps);
  return { registry, strategy, feedback, synthesis };
}

/** A brief that satisfies `marketingStrategyBriefSchema` — the tool schema is a
 *  mirror of it, so a fixture that passes one must pass the other. */
const BRIEF = {
  identity: { product: 'DIY paint-kit figurines', voice: 'warm, crafty', positioning: 'The kit you finish yourself', usp: 'Everything in one box' },
  audience: 'Hobby painters and gift buyers, 18-40, TR',
  channels: [{ key: 'instagram', fitScore: 0.9, rationale: 'Where the craft audience already posts' }],
  contentPillars: [{ title: 'Finished-piece reveals', angle: 'proof', formats: ['reel'], tone: 'warm' }],
  goals: { objective: 'Grow to 500 kits/month', kpis: ['orders', 'reach'] },
  budget: 'Bootstrap: organic + small ad tests',
  competitors: ['SomeOtherKit'],
};

const ACTIONS = [
  { kind: 'CONTENT', title: 'Weekly reveal reel', rationale: 'Shows the finished piece', payload: { pillar: 'Finished-piece reveals' }, priority: 'HIGH' },
];

const CTX = { workspaceId: 'ws1', grantedScopes: [] as string[] };

describe('Faz 5 D4 — strategy MCP tools', () => {
  it('registers exactly the seven strategy tools, all in the strategy domain', () => {
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
        'jeeta.submit_strategy',
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
    // And names the route that does NOT need the platform’s key, since a model
    // reading this is one that could write the strategy itself.
    expect(out.message).toMatch(/jeeta.submit_strategy/);
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
        'jeeta.submit_strategy',
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

  /**
   * `jeeta.submit_strategy` — the strategy half of the pair
   * `jeeta.submit_content_concepts` established.
   *
   * `jeeta.synthesize_strategy` is a model asking the server to ask another
   * model. On the workspace this was written for, that server-side model has no
   * credit left, so BOTH the intake wizard and synthesis return
   * `{skipped:'ai-not-configured'}` and the workspace cannot obtain a first
   * strategy by any route. A connected Claude already holds the brand context;
   * this tool takes the brief it wrote itself and stores it.
   */
  describe('submit_strategy — the credit-free way to a first strategy', () => {
    const ARGS = { archetype: 'B2C_ECOMMERCE', brief: BRIEF, actions: ACTIONS };

    it('hands the submission to the synthesis service unchanged', async () => {
      const { registry, synthesis } = build();
      const out = await registry.get('jeeta.submit_strategy')!.handler(CTX, ARGS);
      expect(synthesis.submitStrategy).toHaveBeenCalledWith('ws1', {
        archetype: 'B2C_ECOMMERCE',
        brief: BRIEF,
        actions: ACTIONS,
      });
      expect(out).toEqual({ strategyId: 's1', actionCount: 2, droppedActions: 0 });
    });

    it('asks no model of its own — the whole point is that none is reachable', async () => {
      const { registry, feedback, strategy } = build();
      await registry.get('jeeta.submit_strategy')!.handler(CTX, ARGS);
      expect(feedback.refresh).not.toHaveBeenCalled();
      expect(strategy.setAutonomy).not.toHaveBeenCalled();
    });

    it('is an ungated WRITE: gating it would leave the gap open until a human noticed', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.submit_strategy')!;
      expect(tool.risk).toBe('WRITE');
      expect(tool.requiresApproval).toBe(false);
      expect(tool.approvalKind).toBeUndefined();
      expect(tool.scopes).toEqual(['settings.manage']);
    });

    /**
     * Deferred, like every tool added since the catalogue hit its advertised
     * ceiling — `jeeta.get_strategy` stays the domain's listed read and
     * `jeeta.find_tools` reaches this by name.
     */
    it('is deferred rather than listed, and says why it exists in its description', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.submit_strategy')!;
      expect(tool.defer).toBe(true);
      expect(tool.description).toMatch(/credit/i);
      expect(tool.description).toMatch(/dry|out of credit/i);
      expect(tool.description).toMatch(/jeeta\.synthesize_strategy/);
    });

    /**
     * The description is read by a model that will act on it, so a promise in
     * it is a control. This one used to say "Nothing here runs: every action
     * waits for a human on jeeta.approve_strategy_action" — false in the write
     * mode that matters, because `ALWAYS_APPROVED_RISKS` (mcp-broker.service.ts)
     * holds DESTRUCTIVE alone and an AUTONOMOUS workspace runs SPEND tools
     * inline. What is true in BOTH modes is narrower: this call executes
     * nothing, and moving an action is a separate call.
     */
    it('describes the human gate in terms that hold in BOTH write modes', () => {
      const { registry } = build();
      const d = registry.get('jeeta.submit_strategy')!.description;
      expect(d).toMatch(/executes nothing/i);
      expect(d).toMatch(/jeeta\.approve_strategy_action/);
      // Names the condition rather than asserting a gate that does not exist.
      expect(d).toMatch(/APPROVAL mode/);
      expect(d).toMatch(/AUTONOMOUS mode/);
      // And makes no unconditional claim that a human is waiting.
      expect(d).not.toMatch(/waits for a human/i);
    });

    /**
     * `submitStrategy` writes no StrategyIntakeSession and
     * `StrategyFeedbackService.refresh` bails without one, so a strategy taken
     * this way cannot be re-synthesized on a workspace that never ran the panel
     * interview. The caller has to be told before it chooses this route.
     */
    it('says what the caller gives up: no intake session, therefore no refresh', () => {
      const { registry } = build();
      const d = registry.get('jeeta.submit_strategy')!.description;
      expect(d).toMatch(/no-intake-session/);
      // …and what to do instead of a refresh.
      expect(d).toMatch(/jeeta\.dismiss_strategy_action/);
      expect(d).toMatch(/interview/i);
    });

    describe('the schema is the first refusal', () => {
      /**
       * Resolved BEFORE any `expect(...).toThrow()`. Reading the schema inside
       * the assertion made every refusal below pass vacuously while the tool
       * did not exist yet: `registry.get(...)!.inputSchema` throws on undefined,
       * and a throw is exactly what these assertions accept.
       */
      const schemaOf = () => {
        const tool = build().registry.get('jeeta.submit_strategy');
        if (!tool) throw new Error('jeeta.submit_strategy is not registered');
        return tool.inputSchema as { parse: (v: unknown) => unknown };
      };

      it('accepts a complete submission', () => {
        const s = schemaOf();
        expect(() => s.parse(ARGS)).not.toThrow();
      });

      /**
       * autonomyLevel is NOT an input. The registry applies `.strict()`, so an
       * agent cannot arrive at ASSISTED-by-default and then quietly widen it in
       * the same call — the same escalation `set_strategy_autonomy` refuses by
       * leaving AUTONOMOUS out of its enum.
       */
      it('refuses autonomyLevel as an argument at all', () => {
        const s = schemaOf();
        expect(() => s.parse({ ...ARGS, autonomyLevel: 'AUTONOMOUS' })).toThrow();
        expect(() => s.parse({ ...ARGS, autonomyLevel: 'ASSISTED' })).toThrow();
      });

      it('refuses to be handed a status or a version', () => {
        const s = schemaOf();
        expect(() => s.parse({ ...ARGS, status: 'ACTIVE' })).toThrow();
        expect(() => s.parse({ ...ARGS, version: 7 })).toThrow();
      });

      it('refuses an archetype outside the registry', () => {
        const s = schemaOf();
        expect(() => s.parse({ ...ARGS, archetype: 'B2C_VIBES' })).toThrow();
        expect(() => s.parse({ ...ARGS, archetype: 'OTHER' })).not.toThrow();
      });

      it('refuses a brief missing a required section', () => {
        const s = schemaOf();
        const { competitors: _dropped, ...noCompetitors } = BRIEF;
        expect(() => s.parse({ ...ARGS, brief: noCompetitors })).toThrow();
        expect(() => s.parse({ ...ARGS, brief: { ...BRIEF, channels: [] } })).toThrow();
        expect(() => s.parse({ ...ARGS, brief: { ...BRIEF, contentPillars: [] } })).toThrow();
      });

      it('refuses a fitScore outside 0..1, which the console renders as a bar', () => {
        const s = schemaOf();
        expect(() => s.parse({ ...ARGS, brief: { ...BRIEF, channels: [{ key: 'x', fitScore: 90, rationale: 'y' }] } })).toThrow();
      });

      /**
       * The strategist prompt states the rule this enforces verbatim: "the
       * ActionPlan is REQUIRED, never empty: it is what the operator approves
       * and the system executes".
       */
      it('refuses an empty ActionPlan and an unknown action kind', () => {
        const s = schemaOf();
        expect(() => s.parse({ ...ARGS, actions: [] })).toThrow();
        expect(() => s.parse({ ...ARGS, actions: [{ kind: 'SEO', title: 'x', rationale: 'y' }] })).toThrow();
      });

      it('refuses an action with no rationale — the reviewer approves on that line', () => {
        const s = schemaOf();
        expect(() => s.parse({ ...ARGS, actions: [{ kind: 'CONTENT', title: 'x', rationale: '' }] })).toThrow();
      });
    });
  });
});
