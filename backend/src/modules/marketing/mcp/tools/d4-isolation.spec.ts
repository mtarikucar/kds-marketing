import { McpToolRegistry } from '../mcp-tool-registry';
import { registerBrandTools } from './brand.tools';
import { registerResearchTools } from './research.tools';
import { registerStrategyTools } from './strategy.tools';
import { registerWorkflowTools } from './workflows.tools';

/**
 * Faz 5 D4 — the tenant boundary, asserted structurally over the WHOLE wave
 * (mirrors `d1-isolation.spec.ts` / `d2-isolation.spec.ts` / `d3-isolation.spec.ts`).
 *
 * D4 is the wave that reaches the BRAIN: the strategy that drives every other
 * lane, the automations that run unattended, the prospecting that spends money
 * on the open web, and the brand voice every piece of AI copy is written in. A
 * workspace leak here is not a wrong list — it is our agent approving another
 * tenant's strategy action (which publishes to THEIR community and spends THEIR
 * research budget), arming their automation, or rewriting their brand voice.
 *
 * Every tool handler is driven with a fixed caller workspace and a deliberately
 * hostile argument set naming a FOREIGN workspace id wherever the schema offers
 * a free-text field to smuggle one into. Every call the tool then makes into a
 * service must carry the CALLER's workspace as its first argument, and the
 * foreign id must appear nowhere.
 */

const CALLER_WS = 'ws-a';
const FOREIGN_WS = 'ws-b';

interface Recorded {
  tool: string;
  service: string;
  method: string;
  args: unknown[];
}

function recorder() {
  const calls: Recorded[] = [];
  let current = '';
  const stub = (service: string, methods: string[], result: unknown) => {
    const obj: Record<string, unknown> = {};
    for (const m of methods) {
      obj[m] = jest.fn(async (...args: unknown[]) => {
        calls.push({ tool: current, service, method: m, args });
        return result;
      });
    }
    return obj as never;
  };
  return { calls, stub, setTool: (t: string) => (current = t) };
}

function buildRegistry() {
  const rec = recorder();
  const principals = {
    resolve: jest.fn(async (ctx: { workspaceId: string }) => {
      rec.calls.push({ tool: 'principals', service: 'principals', method: 'resolve', args: [ctx.workspaceId] });
      return { id: 'sys-1', workspaceId: ctx.workspaceId, role: 'SYSTEM' };
    }),
    assertActiveMember: jest.fn(async (workspaceId: string, userId: string) => {
      rec.calls.push({
        tool: 'principals',
        service: 'principals',
        method: 'assertActiveMember',
        args: [workspaceId, userId],
      });
      return { id: userId, role: 'REP', status: 'ACTIVE', firstName: 'A', lastName: 'B' };
    }),
  };
  // The entitlement gate is itself a workspace-scoped read: it must never be
  // answered from another tenant's package, or a workspace could borrow a
  // module it did not buy (and, here, spend on research it never enabled).
  const entitlements = {
    getEffective: jest.fn(async (workspaceId: string) => {
      rec.calls.push({
        tool: 'entitlements',
        service: 'entitlements',
        method: 'getEffective',
        args: [workspaceId],
      });
      return { features: { workflows: true, research: true } };
    }),
  };
  // An ARMED workflow — the happy path. `jeeta.trigger_workflow`'s refusal on a
  // DRAFT gets its own spec (`workflows.tools.spec.ts`); here the point is only
  // that every call carries the caller's workspace.
  const workflows = {
    ...(rec.stub('workflows', ['list', 'create', 'setStatus'], { id: 'w1' }) as Record<string, unknown>),
    get: jest.fn(async (workspaceId: string, id: string) => {
      rec.calls.push({ tool: 'workflows', service: 'workflows', method: 'get', args: [workspaceId, id] });
      return { id, status: 'ACTIVE' };
    }),
  };

  const registry = new McpToolRegistry();
  registerStrategyTools(registry, {
    strategy: rec.stub(
      'strategy',
      ['getStrategy', 'listActions', 'approveAction', 'dismissAction', 'setAutonomy'],
      [],
    ),
    feedback: rec.stub('feedback', ['refresh'], { strategyId: 's1', actionCount: 0 }),
  });
  registerWorkflowTools(registry, {
    workflows: workflows as never,
    leadBulk: rec.stub('leadBulk', ['bulkEnroll'], { queued: 1 }),
    principals: principals as never,
    entitlements: entitlements as never,
  });
  registerResearchTools(registry, {
    research: rec.stub('research', ['list', 'create', 'usage'], []),
    runner: rec.stub('runner', ['enqueueNow'], undefined),
    entitlements: entitlements as never,
  });
  registerBrandTools(registry, {
    brand: rec.stub('brand', ['search'], []),
    profiles: rec.stub('profiles', ['get', 'upsert'], { brandName: 'x' }),
  });
  return { registry, rec };
}

/**
 * Every D4 tool, with a foreign workspace id planted in every free-text field
 * the schema exposes.
 */
const D4_CALLS: Array<[string, Record<string, unknown>]> = [
  ['jeeta.get_strategy', {}],
  ['jeeta.list_strategy_actions', { status: 'PROPOSED' }],
  ['jeeta.approve_strategy_action', { actionId: FOREIGN_WS }],
  ['jeeta.dismiss_strategy_action', { actionId: FOREIGN_WS }],
  ['jeeta.synthesize_strategy', {}],
  ['jeeta.set_strategy_autonomy', { level: 'SHADOW' }],
  ['jeeta.list_workflows', {}],
  ['jeeta.get_workflow', { workflowId: FOREIGN_WS }],
  [
    'jeeta.create_workflow',
    {
      name: FOREIGN_WS,
      description: FOREIGN_WS,
      trigger: { type: 'lead.created' },
      steps: [{ type: 'stop_workflow' }],
    },
  ],
  ['jeeta.set_workflow_enabled', { workflowId: FOREIGN_WS, enabled: true }],
  ['jeeta.trigger_workflow', { workflowId: FOREIGN_WS, leadIds: [FOREIGN_WS] }],
  ['jeeta.list_research_profiles', {}],
  [
    'jeeta.create_research_profile',
    {
      name: FOREIGN_WS,
      icpDescription: `${FOREIGN_WS} restaurants with several branches that still take orders on paper`,
      exclusions: FOREIGN_WS,
    },
  ],
  ['jeeta.run_research', { profileId: FOREIGN_WS }],
  ['jeeta.get_brand_profile', {}],
  ['jeeta.update_brand_profile', { brandName: FOREIGN_WS, voiceGuide: FOREIGN_WS }],
];

describe('Faz 5 D4 — workspace isolation across the whole wave', () => {
  it.each(D4_CALLS)('%s passes the CALLER workspace to every service it touches', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);

    const made = rec.calls.filter(
      (c) =>
        c.tool === name ||
        c.service === 'principals' ||
        c.service === 'entitlements' ||
        c.service === 'workflows',
    );
    expect(made.length).toBeGreaterThan(0); // the drive itself must not be a no-op
    for (const call of made) {
      expect(call.args[0]).toBe(CALLER_WS);
    }
  });

  it.each(D4_CALLS)('%s never lets a caller-supplied value become the workspace', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);
    for (const call of rec.calls) {
      expect(call.args[0]).not.toBe(FOREIGN_WS);
    }
  });

  it('exposes no D4 tool that accepts a workspaceId argument at all', () => {
    const { registry } = buildRegistry();
    for (const [name] of D4_CALLS) {
      const schema = registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown };
      // Strict mode (applied centrally by the registry) turns an undeclared
      // argument into an error rather than a silently-dropped one, so this
      // proves the field is absent from the schema, not merely ignored.
      expect(() => schema.parse({ workspaceId: FOREIGN_WS })).toThrow();
    }
  });

  it('classifies every D4 tool, and puts SPEND/DESTRUCTIVE behind a mandatory approval', () => {
    const { registry } = buildRegistry();
    for (const [name] of D4_CALLS) {
      const tool = registry.get(name)!;
      expect(['READ', 'WRITE', 'SPEND', 'DESTRUCTIVE']).toContain(tool.risk);
      if (tool.risk === 'SPEND' || tool.risk === 'DESTRUCTIVE') {
        expect(tool.requiresApproval).toBe(true);
      }
      if (tool.risk === 'READ') expect(tool.requiresApproval).toBe(false);
    }
  });

  /**
   * The D4 invariant that matters most, pinned by NAME so a future refactor
   * cannot quietly demote one of these to an unattended write.
   *
   * Four tools take money or authority out of the workspace:
   *  - `approve_strategy_action` EXECUTES the action (research spend, live
   *    community post, AI credits, ad-account write);
   *  - `synthesize_strategy` and `run_research` burn AI credits plus live
   *    firecrawl/apify money;
   *  - `trigger_workflow` runs a real automation over real leads (sends + AI).
   * All four are SPEND, i.e. queued in EVERY write mode.
   *
   * Two more are gated without being SPEND, because their damage is authority
   * rather than cash: arming an automation, and changing the strategy lane.
   */
  it('names every gated D4 tool explicitly (no silent reclassification)', () => {
    const { registry } = buildRegistry();
    const gated = D4_CALLS.map(([n]) => registry.get(n)!)
      .filter((t) => t.requiresApproval)
      .map((t) => `${t.name}:${t.risk}:${t.approvalKind}`)
      .sort();
    expect(gated).toEqual(
      [
        'jeeta.approve_strategy_action:SPEND:STRATEGY_ACTION',
        'jeeta.synthesize_strategy:SPEND:AI_SPEND',
        'jeeta.run_research:SPEND:AI_SPEND',
        'jeeta.trigger_workflow:SPEND:SEND',
        'jeeta.set_workflow_enabled:WRITE:CHANNEL_LAUNCH',
        'jeeta.set_strategy_autonomy:WRITE:TARGET_CHANGE',
      ].sort(),
    );
  });

  /**
   * The mirror of the above: authoring, reading and tidying up must stay
   * ungated, or every draft becomes an approval card and the queue stops being
   * a signal.
   */
  it('leaves reads, draft authoring and configuration unattended', () => {
    const { registry } = buildRegistry();
    const ungated = D4_CALLS.map(([n]) => registry.get(n)!)
      .filter((t) => !t.requiresApproval)
      .map((t) => t.name)
      .sort();
    expect(ungated).toEqual(
      [
        'jeeta.get_strategy',
        'jeeta.list_strategy_actions',
        'jeeta.dismiss_strategy_action',
        'jeeta.list_workflows',
        'jeeta.get_workflow',
        'jeeta.create_workflow',
        'jeeta.list_research_profiles',
        'jeeta.create_research_profile',
        'jeeta.get_brand_profile',
        'jeeta.update_brand_profile',
      ].sort(),
    );
  });

  /** Every D4 tool declares a domain, so progressive disclosure can place it. */
  it('gives every D4 tool a domain', () => {
    const { registry } = buildRegistry();
    for (const [name] of D4_CALLS) {
      expect(['strategy', 'workflows', 'research', 'brand']).toContain(registry.get(name)!.domain);
    }
  });

  /**
   * Spec §7's never-tools, re-asserted at the wave that came closest to
   * breaching them. D4 exposes the Strategy Engine's approve/dismiss verbs and
   * an autonomy switch — which is exactly the shape of "onay verme/reddetme"
   * and "yetki yükseltme". Neither may become an unattended capability:
   * approving is queued for a human in every mode, and the autonomy lane the
   * agent would need in order to skip that queue is not offerable at all.
   */
  it('never lets the agent become the approver, or widen its own lane', () => {
    const { registry } = buildRegistry();
    const approve = registry.get('jeeta.approve_strategy_action')!;
    expect(approve.risk).toBe('SPEND'); // ALWAYS_APPROVED_RISKS — no write mode bypasses it
    expect(approve.requiresApproval).toBe(true);

    const autonomy = registry.get('jeeta.set_strategy_autonomy')!.inputSchema as {
      parse: (v: unknown) => unknown;
    };
    expect(() => autonomy.parse({ level: 'AUTONOMOUS' })).toThrow();

    // And there is no tool anywhere in D4 that decides an ApprovalRequest.
    for (const [name] of D4_CALLS) {
      expect(name).not.toMatch(/approve_(request|approval)|decide_approval|grant_/);
    }
  });
});

describe('Faz 5 D4 — the module gate refuses an unentitled workspace', () => {
  function unentitledRegistry() {
    const entitlements = { getEffective: jest.fn(async () => ({ features: {} })) };
    const noop = new Proxy({}, { get: () => jest.fn(async () => ({})) }) as never;
    const registry = new McpToolRegistry();
    registerWorkflowTools(registry, {
      workflows: noop,
      leadBulk: noop,
      principals: noop,
      entitlements: entitlements as never,
    });
    registerResearchTools(registry, { research: noop, runner: noop, entitlements: entitlements as never });
    return registry;
  }

  const GATED: Array<[string, string, Record<string, unknown>]> = [
    ['jeeta.list_workflows', 'workflows', {}],
    ['jeeta.get_workflow', 'workflows', { workflowId: 'w1' }],
    [
      'jeeta.create_workflow',
      'workflows',
      { name: 'n', trigger: { type: 'lead.created' }, steps: [{ type: 'stop_workflow' }] },
    ],
    ['jeeta.set_workflow_enabled', 'workflows', { workflowId: 'w1', enabled: true }],
    ['jeeta.trigger_workflow', 'workflows', { workflowId: 'w1', leadIds: ['l1'] }],
    ['jeeta.list_research_profiles', 'research', {}],
    [
      'jeeta.create_research_profile',
      'research',
      { name: 'n', icpDescription: 'restaurants in Istanbul that still take phone orders on paper' },
    ],
    ['jeeta.run_research', 'research', { profileId: 'p1' }],
  ];

  it.each(GATED)('%s refuses cleanly without the "%s" feature', async (name, feature, args) => {
    const registry = unentitledRegistry();
    await expect(
      registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args),
    ).rejects.toMatchObject({ response: { code: 'FEATURE_NOT_IN_PACKAGE', feature } });
  });
});
