import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCampaignWriteTools } from './campaigns-write.tools';
import { registerConversationWriteTools } from './conversations-write.tools';
import { registerEmailTools } from './email.tools';
import { registerVoiceTools } from './voice.tools';

/**
 * Faz 5 D3 — the tenant boundary, asserted structurally over the WHOLE wave
 * (mirrors `d1-isolation.spec.ts` / `d2-isolation.spec.ts`).
 *
 * D3 is the wave that reaches PEOPLE: it emails them, it rings their phone, and
 * it drafts the campaigns that will do both to a whole audience. A workspace
 * leak here is not a wrong list — it is our email landing in another tenant's
 * customer's inbox, or our robocall dialling their audience, under their
 * sending identity and against their İYS consent records.
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
  // feature it did not buy. Recorded like any other service call.
  const entitlements = {
    getEffective: jest.fn(async (workspaceId: string) => {
      rec.calls.push({
        tool: 'entitlements',
        service: 'entitlements',
        method: 'getEffective',
        args: [workspaceId],
      });
      return { features: { campaigns: true, telephony: true, voiceCampaigns: true, conversationAi: true } };
    }),
  };
  // A reachable, opted-in lead — the happy path. The refusal paths get their
  // own spec (`voice.tools.spec.ts`); here the point is only that every call
  // carries the caller's workspace.
  const leads = {
    findOne: jest.fn(async (workspaceId: string, id: string) => {
      rec.calls.push({ tool: 'leads', service: 'leads', method: 'findOne', args: [workspaceId, id] });
      return { id, phone: '+905551112233', smsOptOut: false, deletedAt: null, mergedIntoId: null };
    }),
  };

  const registry = new McpToolRegistry();
  const campaigns = rec.stub('campaigns', ['create', 'launch', 'remove'], { id: 'cmp1' });
  registerCampaignWriteTools(registry, { campaigns, entitlements: entitlements as never });
  registerEmailTools(registry, {
    templates: rec.stub('templates', ['list'], []),
    campaigns,
    entitlements: entitlements as never,
  });
  registerVoiceTools(registry, {
    calls: rec.stub('calls', ['startCall', 'list'], { call: { id: 'c1' } }),
    leads: leads as never,
    campaigns,
    principals: principals as never,
    entitlements: entitlements as never,
  });
  registerConversationWriteTools(registry, {
    conversations: rec.stub('conversations', ['assign', 'close', 'reopen', 'addNote'], { id: 'cv1' }),
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, rec };
}

/**
 * Every D3 tool, with a foreign workspace id planted in every free-text field
 * the schema exposes.
 */
const D3_CALLS: Array<[string, Record<string, unknown>]> = [
  ['jeeta.list_email_templates', {}],
  ['jeeta.send_email', { leadId: FOREIGN_WS, subject: FOREIGN_WS, body: FOREIGN_WS }],
  [
    'jeeta.create_campaign',
    {
      name: FOREIGN_WS,
      channel: 'EMAIL',
      body: FOREIGN_WS,
      audienceFilter: [{ field: 'city', op: 'eq', value: FOREIGN_WS }],
    },
  ],
  ['jeeta.click_to_dial', { leadId: FOREIGN_WS }],
  ['jeeta.list_calls', { leadId: FOREIGN_WS, marketingUserId: FOREIGN_WS }],
  [
    'jeeta.create_voice_campaign',
    { name: FOREIGN_WS, body: FOREIGN_WS, voiceConfig: { msg: FOREIGN_WS } },
  ],
  ['jeeta.assign_conversation', { conversationId: FOREIGN_WS, assignedToId: FOREIGN_WS }],
  ['jeeta.close_conversation', { conversationId: FOREIGN_WS }],
  ['jeeta.add_conversation_note', { conversationId: FOREIGN_WS, body: FOREIGN_WS }],
];

describe('Faz 5 D3 — workspace isolation across the whole wave', () => {
  it.each(D3_CALLS)('%s passes the CALLER workspace to every service it touches', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);

    const made = rec.calls.filter(
      (c) =>
        c.tool === name ||
        c.service === 'principals' ||
        c.service === 'entitlements' ||
        c.service === 'leads',
    );
    expect(made.length).toBeGreaterThan(0); // the drive itself must not be a no-op
    for (const call of made) {
      expect(call.args[0]).toBe(CALLER_WS);
    }
  });

  it.each(D3_CALLS)('%s never lets a caller-supplied value become the workspace', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);
    for (const call of rec.calls) {
      expect(call.args[0]).not.toBe(FOREIGN_WS);
    }
  });

  it('exposes no D3 tool that accepts a workspaceId argument at all', () => {
    const { registry } = buildRegistry();
    for (const [name] of D3_CALLS) {
      const schema = registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown };
      // Strict mode (applied centrally by the registry) turns an undeclared
      // argument into an error rather than a silently-dropped one, so this
      // proves the field is absent from the schema, not merely ignored.
      expect(() => schema.parse({ workspaceId: FOREIGN_WS })).toThrow();
    }
  });

  it('classifies every D3 tool, and puts SPEND/DESTRUCTIVE behind a mandatory approval', () => {
    const { registry } = buildRegistry();
    for (const [name] of D3_CALLS) {
      const tool = registry.get(name)!;
      expect(['READ', 'WRITE', 'SPEND', 'DESTRUCTIVE']).toContain(tool.risk);
      if (tool.risk === 'SPEND' || tool.risk === 'DESTRUCTIVE') {
        expect(tool.requiresApproval).toBe(true);
      }
      if (tool.risk === 'READ') expect(tool.requiresApproval).toBe(false);
    }
  });

  /**
   * The D3 invariant that matters most: reaching a real human — by email or by
   * ringing their phone — is the same class of act as publishing, and is
   * approval-gated. Pinned by NAME so a future refactor cannot quietly demote
   * one of them to an unattended write.
   */
  it('names every human-reaching D3 tool explicitly (no silent reclassification)', () => {
    const { registry } = buildRegistry();
    const gated = D3_CALLS.map(([n]) => registry.get(n)!)
      .filter((t) => t.requiresApproval)
      .map((t) => `${t.name}:${t.risk}:${t.approvalKind}`)
      .sort();
    expect(gated).toEqual(['jeeta.send_email:WRITE:SEND', 'jeeta.click_to_dial:WRITE:SEND'].sort());
  });

  /**
   * The mirror of the above: the tools that do NOT reach anyone must stay
   * ungated, or every draft becomes an approval card and the queue stops being
   * a signal. Draft-authoring and internal triage are deliberately unattended.
   */
  it('leaves draft authoring and internal triage unattended', () => {
    const { registry } = buildRegistry();
    const ungated = D3_CALLS.map(([n]) => registry.get(n)!)
      .filter((t) => !t.requiresApproval)
      .map((t) => t.name)
      .sort();
    expect(ungated).toEqual(
      [
        'jeeta.list_email_templates',
        'jeeta.create_campaign',
        'jeeta.create_voice_campaign',
        'jeeta.list_calls',
        'jeeta.assign_conversation',
        'jeeta.close_conversation',
        'jeeta.add_conversation_note',
      ].sort(),
    );
  });

  /** Every D3 tool declares a domain, so progressive disclosure can place it. */
  it('gives every D3 tool a domain', () => {
    const { registry } = buildRegistry();
    for (const [name] of D3_CALLS) {
      expect(['email', 'campaigns', 'voice', 'inbox']).toContain(registry.get(name)!.domain);
    }
  });
});

describe('Faz 5 D3 — the package gate refuses an unentitled workspace', () => {
  /**
   * Same shape of check `FeatureGuard` makes over REST: a workspace cannot
   * reach through MCP something its package denies, and the refusal is a
   * sentence an agent can relay rather than a 500 from a service that assumed
   * the module was provisioned.
   */
  function unentitledRegistry() {
    const entitlements = { getEffective: jest.fn(async () => ({ features: {} })) };
    const noop = new Proxy({}, { get: () => jest.fn(async () => ({})) }) as never;
    const registry = new McpToolRegistry();
    registerCampaignWriteTools(registry, { campaigns: noop, entitlements: entitlements as never });
    registerEmailTools(registry, { templates: noop, campaigns: noop, entitlements: entitlements as never });
    registerVoiceTools(registry, {
      calls: noop,
      leads: noop,
      campaigns: noop,
      principals: noop,
      entitlements: entitlements as never,
    });
    registerConversationWriteTools(registry, {
      conversations: noop,
      principals: noop,
      entitlements: entitlements as never,
    });
    return registry;
  }

  const GATED: Array<[string, string, Record<string, unknown>]> = [
    ['jeeta.list_email_templates', 'campaigns', {}],
    ['jeeta.send_email', 'campaigns', { leadId: 'l1', subject: 's', body: 'b' }],
    ['jeeta.create_campaign', 'campaigns', { name: 'n', channel: 'EMAIL', body: 'b' }],
    ['jeeta.click_to_dial', 'telephony', { leadId: 'l1' }],
    ['jeeta.list_calls', 'telephony', {}],
    ['jeeta.create_voice_campaign', 'voiceCampaigns', { name: 'n', body: 'b', voiceConfig: { msg: 'hi' } }],
    ['jeeta.assign_conversation', 'conversationAi', { conversationId: 'c1' }],
    ['jeeta.close_conversation', 'conversationAi', { conversationId: 'c1' }],
    ['jeeta.add_conversation_note', 'conversationAi', { conversationId: 'c1', body: 'note' }],
  ];

  it.each(GATED)('%s refuses cleanly without the "%s" feature', async (name, feature, args) => {
    const registry = unentitledRegistry();
    await expect(
      registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args),
    ).rejects.toMatchObject({ response: { code: 'FEATURE_NOT_IN_PACKAGE', feature } });
  });
});
