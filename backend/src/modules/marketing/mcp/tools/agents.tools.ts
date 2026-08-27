import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { AgentProfileService } from '../../ai/agent-profile.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface AgentToolDeps {
  agents: AgentProfileService;
  entitlements: EntitlementsService;
}

/**
 * Agent Studio over MCP — read and refine the personas that actually answer
 * customers.
 *
 * The catalogue had no agent tool at all, which became a correctness problem
 * the moment the strategy started PROVISIONING an agent automatically
 * (v2.169.0) and an agent could be attached to a channel: the first real
 * customer workspace ended up with a live agent whose persona came from a
 * strategy brief that was later corrected, and nothing short of the panel
 * could fix it. An agent answering customers with superseded facts — wrong
 * product mode, wrong prices — is worse than no agent, so the ability to
 * inspect and correct one belongs on the same surface that can create it.
 *
 * Both tools are workspace CONFIGURATION: nothing is sent, published or spent.
 * They are gated on `conversationAi` (the package boundary every agent route
 * enforces) and deferred — refining a persona is occasional work, and
 * `jeeta.call_tool` makes deferred genuinely reachable.
 *
 * Deliberately NO create and NO delete. The strategy provisions the first
 * agent from the brief, which is the intended path; a delete would let an
 * agent silently remove the persona a channel depends on.
 */
export function registerAgentTools(registry: McpToolRegistry, deps: AgentToolDeps): void {
  registry.register({
    name: 'jeeta.list_agents',
    description:
      'List this workspace\'s AI agent profiles — the personas that answer customers on connected channels — ' +
      'with their id, name, status, tone, goals and the channels they are attached to. Read this before ' +
      'refining one with jeeta.update_agent, or to find the agentProfileId for a new channel. Read-only.',
    domain: 'inbox',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      const rows = await deps.agents.list(ctx.workspaceId);
      // Trim to what a model needs to decide; the full text would otherwise
      // dominate the response. jeeta.get_agent returns the rest.
      return rows.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        tone: a.tone,
        goals: a.goals,
        language: a.language,
        personaPreview: typeof a.persona === 'string' ? a.persona.slice(0, 400) : null,
        channels: a.channels ?? null,
      }));
    },
  });

  /**
   * The whole profile, including the parts that decide whether the AI ever
   * answers at all.
   *
   * `handoffRules.keywords` is checked in reply() BEFORE the model runs: any
   * match escalates to a human and returns. One over-broad word — "fiyat" on a
   * brand whose agent is told to quote prices — silently converts every
   * relevant conversation into an escalation, and the AI looks broken again.
   *
   * That field was write-only. It can be set through update_agent and the DTO,
   * and the single place that READS it is the reply engine. Not the panel, not
   * the tool catalogue, nowhere a human could look. Same for guardrails,
   * captureFields, the follow-up policy, the daily reply cap and the attached
   * knowledge docs: all of them shape what the customer receives, and none of
   * them could be inspected.
   */
  registry.register({
    name: 'jeeta.get_agent',
    description:
      "Read ONE agent profile in full: persona, guardrails, handoff rules, capture fields, follow-up " +
      'policy, daily reply cap and attached knowledge docs. jeeta.list_agents trims these away. Reach for ' +
      'this before concluding an agent is misbehaving — a handoff keyword matches BEFORE the model runs, ' +
      'so an over-broad one silently escalates every conversation it touches. Read-only.',
    // Same domain as its siblings in this file — the agent tools live under
    // 'inbox' because that is where an agent's behaviour is observed.
    domain: 'inbox',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      agentId: z.string().min(1).describe('Agent profile id, from jeeta.list_agents.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      return deps.agents.get(ctx.workspaceId, String(args.agentId));
    },
  });

  registry.register({
    name: 'jeeta.update_agent',
    description:
      "Refine an AI agent's persona, tone, goals or guardrails. Only the fields you pass change; everything " +
      'else is left exactly as it was. Nothing is sent or published — but this DOES change how the agent ' +
      'answers real customers on every channel it is attached to, so keep it faithful to what the business ' +
      'actually sells. Use jeeta.list_agents to find the id.',
    domain: 'inbox',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      agentId: z.string().min(1).max(64).describe('Agent profile id, from jeeta.list_agents.'),
      name: z.string().min(1).max(100).optional().describe('Display name.'),
      persona: z
        .string()
        .min(1)
        .max(8000)
        .optional()
        .describe('Who the agent is and how it should behave — the core instruction it answers from.'),
      tone: z.string().max(200).optional().describe('Tone of voice, e.g. "samimi, net".'),
      goals: z.string().max(2000).optional().describe('What the agent is trying to achieve in a conversation.'),
      guardrails: z
        .string()
        .max(4000)
        .optional()
        .describe('What it must never do or claim — e.g. facts it may not invent, prices it may not quote.'),
      language: z.string().max(8).optional().describe('Reply language code, e.g. "tr".'),
      status: z.enum(['ACTIVE', 'PAUSED']).optional().describe('PAUSED stops it answering without deleting it.'),
      captureFields: z
        .array(z.enum(['name', 'phone', 'email', 'city']))
        .max(4)
        .optional()
        .describe(
          'Contact details the agent should work into the conversation and record. Without these, an inbound ' +
            'chat produces an unnamed, uncontactable lead — nothing downstream (call, email, convert) can act on it.',
        ),
      maxRepliesPerConvoDaily: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Cap on AI replies per conversation per day — the runaway-loop guard.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      const { agentId, ...rest } = args as Record<string, unknown>;
      // Forward ONLY supplied keys: AgentProfileService.update writes what it
      // receives, so spreading undefined would blank fields nobody asked to
      // change (the clear-doesn't-persist trap, inverted).
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      return deps.agents.update(ctx.workspaceId, String(agentId), patch as never);
    },
  });
}
