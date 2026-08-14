import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContentTools } from './content.tools';
import { registerSocialCampaignTools } from './social-campaigns.tools';
import { registerSocialTools } from './social.tools';

/**
 * Faz 5 D2 — the tenant boundary, asserted structurally over the WHOLE wave
 * (mirrors `d1-isolation.spec.ts`).
 *
 * D2 is the first MCP wave that publishes to a real audience on a timer, spends
 * real money, and permanently deletes rows. A workspace leak here is not a
 * wrong list: it is another tenant's post going out under our schedule, another
 * tenant's credits burned on our prompt, or another tenant's content deleted.
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
    assertActiveMember: jest.fn(),
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
      return { features: { mediaGen: true, socialCampaigns: true } };
    }),
  };

  const registry = new McpToolRegistry();
  registerSocialTools(registry, {
    social: rec.stub(
      'social',
      ['listPosts', 'createPost', 'publishNow', 'getPost', 'updatePost', 'deletePost', 'schedulePost', 'listAccounts'],
      [],
    ),
  });
  registerContentTools(registry, {
    calendar: rec.stub('calendar', ['range'], []),
    media: rec.stub('media', ['requestGeneration', 'listAssets'], { assetId: 'as1' }),
    principals: principals as never,
    entitlements: entitlements as never,
  });
  registerSocialCampaignTools(registry, {
    socialCampaigns: rec.stub('socialCampaigns', ['list', 'create', 'pause'], { id: 'sc1' }),
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, rec };
}

/**
 * Every D2 tool, with a foreign workspace id planted in every free-text field
 * the schema exposes.
 */
const D2_CALLS: Array<[string, Record<string, unknown>]> = [
  ['jeeta.list_social_accounts', { network: FOREIGN_WS }],
  ['jeeta.list_scheduled_posts', { status: 'ANY' }],
  ['jeeta.get_social_post', { postId: FOREIGN_WS }],
  ['jeeta.draft_social_post', { content: FOREIGN_WS, targetAccountIds: [FOREIGN_WS] }],
  ['jeeta.update_social_post', { postId: 'p1', content: FOREIGN_WS }],
  ['jeeta.schedule_social_post', { postId: 'p1', scheduledAt: '2026-08-05T09:30:00.000Z', targetAccountIds: [FOREIGN_WS] }],
  ['jeeta.publish_social_post', { postId: 'p1' }],
  ['jeeta.delete_social_post', { postId: 'p1' }],
  ['jeeta.get_content_calendar', {}],
  ['jeeta.generate_image', { prompt: FOREIGN_WS }],
  ['jeeta.generate_video', { prompt: FOREIGN_WS, durationSec: 5 }],
  ['jeeta.list_generated_media', { socialCampaignId: FOREIGN_WS }],
  ['jeeta.list_social_campaigns', {}],
  [
    'jeeta.create_social_campaign',
    {
      name: FOREIGN_WS,
      brief: { note: FOREIGN_WS },
      automationMode: 'APPROVAL',
      planningMode: 'AI_PROPOSE',
      cadence: { daysOfWeek: [1], timeOfDay: '09:00' },
      startDate: '2026-08-01T00:00:00.000Z',
      targetAccountIds: [FOREIGN_WS],
      mediaKinds: ['IMAGE'],
    },
  ],
  ['jeeta.pause_social_campaign', { campaignId: FOREIGN_WS }],
];

describe('Faz 5 D2 — workspace isolation across the whole wave', () => {
  it.each(D2_CALLS)('%s passes the CALLER workspace to every service it touches', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);

    const made = rec.calls.filter(
      (c) => c.tool === name || c.service === 'principals' || c.service === 'entitlements',
    );
    expect(made.length).toBeGreaterThan(0); // the drive itself must not be a no-op
    for (const call of made) {
      expect(call.args[0]).toBe(CALLER_WS);
    }
  });

  it.each(D2_CALLS)('%s never lets a caller-supplied value become the workspace', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);
    for (const call of rec.calls) {
      expect(call.args[0]).not.toBe(FOREIGN_WS);
    }
  });

  it('exposes no D2 tool that accepts a workspaceId argument at all', () => {
    const { registry } = buildRegistry();
    for (const [name] of D2_CALLS) {
      const schema = registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown };
      // Strict mode (applied centrally by the registry) turns an undeclared
      // argument into an error rather than a silently-dropped one, so this
      // proves the field is absent from the schema, not merely ignored.
      expect(() => schema.parse({ workspaceId: FOREIGN_WS })).toThrow();
    }
  });

  it('classifies every D2 tool, and puts SPEND/DESTRUCTIVE behind a mandatory approval', () => {
    const { registry } = buildRegistry();
    for (const [name] of D2_CALLS) {
      const tool = registry.get(name)!;
      expect(['READ', 'WRITE', 'SPEND', 'DESTRUCTIVE']).toContain(tool.risk);
      if (tool.risk === 'SPEND' || tool.risk === 'DESTRUCTIVE') {
        // The broker gates on the risk class, but a tool that also declares
        // requiresApproval keeps the invariant visible at the registration
        // site and in `tools/list` metadata.
        expect(tool.requiresApproval).toBe(true);
      }
      if (tool.risk === 'READ') expect(tool.requiresApproval).toBe(false);
    }
  });

  it('names every audience-reaching or money-spending D2 tool explicitly (no silent reclassification)', () => {
    const { registry } = buildRegistry();
    const gated = D2_CALLS.map(([n]) => registry.get(n)!)
      .filter((t) => t.requiresApproval)
      .map((t) => `${t.name}:${t.risk}:${t.approvalKind}`)
      .sort();
    expect(gated).toEqual(
      [
        'jeeta.schedule_social_post:WRITE:PUBLISH',
        'jeeta.publish_social_post:WRITE:PUBLISH',
        'jeeta.delete_social_post:DESTRUCTIVE:DESTRUCTIVE',
        'jeeta.generate_image:SPEND:MEDIA_SPEND',
        'jeeta.generate_video:SPEND:MEDIA_SPEND',
        // Stopping a publisher, not reaching an audience — its own kind so the
        // approvals queue does not label a halt as a target change.
        'jeeta.pause_social_campaign:WRITE:CAMPAIGN_PAUSE',
      ].sort(),
    );
  });
});
