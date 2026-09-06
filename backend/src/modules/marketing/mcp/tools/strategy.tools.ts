import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { StrategyService } from '../../strategy/strategy.service';
import { StrategyFeedbackService } from '../../strategy/feedback/strategy-feedback.service';
import { MAX_ACTIONS, StrategySynthesisService } from '../../strategy/synthesis/strategy-synthesis.service';
import { ARCHETYPES } from '../../strategy/archetypes';
import { marketingStrategyBriefSchema } from '../../strategy/strategy.schema';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface StrategyToolDeps {
  strategy: StrategyService;
  /**
   * Re-synthesis runs through the FEEDBACK service, never
   * `StrategySynthesisService.synthesize` directly — see
   * `jeeta.synthesize_strategy` below for why.
   */
  feedback: StrategyFeedbackService;
  /**
   * Only for `submitStrategy` — the credit-free writer. `synthesize()` is
   * unreachable from here on purpose (it needs an intake session id an agent
   * cannot obtain); that path is `feedback.refresh`.
   */
  synthesis: StrategySynthesisService;
}

const ACTION_STATUSES = ['PROPOSED', 'APPROVED', 'RUNNING', 'DONE', 'FAILED', 'DISMISSED'] as const;

/**
 * The autonomy lanes this tool is willing to SET.
 *
 * `AUTONOMY_LEVELS` (strategy.service.ts) has a third member, `AUTONOMOUS`, and
 * its absence here is the entire point — see the `jeeta.set_strategy_autonomy`
 * doc block. Declared as a literal tuple rather than a filter over the service
 * constant so that a future lane added to the product cannot silently become
 * settable over MCP just because it was appended upstream.
 */
const SETTABLE_AUTONOMY = ['SHADOW', 'ASSISTED'] as const;

/**
 * The archetype vocabulary `jeeta.submit_strategy` accepts, DERIVED from the
 * runtime registry rather than typed out again.
 *
 * `MarketingStrategy.archetype` is a plain string column, so the only thing
 * standing between a submission and a value the engine cannot read is this
 * enum. Reading `ARCHETYPES` means an archetype added to the registry (a config
 * change, pinned by archetypes.tripwire.spec.ts) is submittable the same day
 * instead of after someone remembers this file.
 */
const ARCHETYPE_KEYS = Object.keys(ARCHETYPES) as [string, ...string[]];

/** The ActionPlan kinds an executor exists for. Same five
 *  `StrategySynthesisService.normalizeActions` keeps. */
const ACTION_KINDS = ['LEAD_HUNT', 'CONTENT', 'CHANNEL_SETUP', 'AD_CAMPAIGN', 'COMMUNITY_ENGAGE'] as const;

/**
 * Faz 5 D4 — the Strategy Engine: the brain. This is the wave's headline
 * surface ("strateji oluşturabilmeli"), and also the one where a careless risk
 * classification would hand an agent more authority than the product's own
 * autonomous lane has.
 *
 * ## `jeeta.approve_strategy_action` is SPEND, not WRITE
 *
 * `StrategyService.approveAction` does not just flip a status column. It
 * `await`s `StrategyOrchestrator.execute` in-process, which dispatches the
 * action to its executor immediately:
 *
 *  - `LEAD_HUNT` creates a ResearchProfile and runs the research worker inline
 *    — real firecrawl/apify money plus `research.qualify` AI credits;
 *  - `COMMUNITY_ENGAGE` composes copy with Claude and, when the workspace has
 *    connected Discord or Reddit, PUBLISHES it live to that community;
 *  - `CONTENT` spends AI credits composing and stages a draft post;
 *  - `AD_CAMPAIGN` provisions a PAUSED Meta campaign shell (spend-safe by
 *    construction, but it does write to a live ad account).
 *
 * Money leaves the workspace and a message can reach a public community, and
 * neither is recoverable by reading the audit log afterwards. So this tool is
 * `SPEND` and `requiresApproval`, which queues it for a human in APPROVAL write
 * mode.
 *
 * NOT in every write mode. `ALWAYS_APPROVED_RISKS` in mcp-broker.service.ts
 * holds `DESTRUCTIVE` alone: SPEND was taken out of it (that file records the
 * owner decision verbatim; `d4-approval-gate.spec.ts` dates it 2026-08-12), so
 * an AUTONOMOUS workspace runs this inline. That spec pins both halves. The paragraphs below are about
 * what the risk class buys in APPROVAL mode; in AUTONOMOUS mode the human gate
 * is the write mode the owner chose, not this classification.
 *
 * That matters more here than anywhere else in the catalogue, because of what
 * the strategy lane's own gate is. The product's default lane is `ASSISTED` =
 * "approve-to-run": a HUMAN approving each action is the safety mechanism.
 * Exposing approval as a plain WRITE would let the same agent that asked for
 * the plan (`jeeta.synthesize_strategy`) also approve every item of it — the
 * proposer approving its own proposal, which is not a gate at all. Worse, it
 * would be a STRONGER path than the product's real autonomous lane:
 * `StrategyOrchestrator.applyPlan` refuses to auto-run the spend/publish kinds
 * unless the `GROWTH_AUTOPILOT_AUTONOMY` env kill-switch is armed, whereas
 * `approveAction` has no such check. An unattended MCP approve would therefore
 * route around a guardrail that even `autonomyLevel: AUTONOMOUS` cannot pass.
 *
 * Design spec §7 lists "onay verme/reddetme (insan kapısı)" as a never-tool.
 * The reading applied here: an agent may ASK for an action to be executed, it
 * may never BE the approver. Routing the request through the MCP approval
 * queue keeps a real human as the decider — the card just moves from the
 * strategy screen to the approvals screen, where it names the action id.
 *
 * ## `jeeta.dismiss_strategy_action` is deliberately ungated
 * Dismissal only ever REMOVES an item from the plan. It spends nothing, sends
 * nothing and is the direction of travel we want an agent to be free in. A gate
 * here would mean the agent can propose work but not tidy it up.
 */
export function registerStrategyTools(registry: McpToolRegistry, deps: StrategyToolDeps): void {
  registry.register({
    name: 'jeeta.get_strategy',
    description:
      "Read this workspace's active marketing strategy: the business archetype, the synthesized brief (identity, target audience, channel fit, content pillars, goals/KPIs, budget, competitors), its version and its autonomy lane. Read this before proposing marketing work — it is the plan everything else should serve.",
    domain: 'strategy',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      const strategy = await deps.strategy.getStrategy(ctx.workspaceId);
      // A bare `null` tells a model nothing it can act on. Say what is missing
      // and BOTH routes out of it — the human one, and the one the reader of
      // this message can take itself. Naming only the interview sent a
      // connected Claude to a wizard gated on the platform's Anthropic key,
      // which is exactly the key that is dry when a workspace has got this far
      // with no strategy.
      return (
        strategy ?? {
          strategy: null,
          message:
            'This workspace has no synthesized strategy yet. Either run the strategy interview in the panel ' +
            '(Strategy > start), which synthesizes one from that intake session with the platform model, or — if ' +
            'you are a connected Claude — write the brief yourself and store it with jeeta.submit_strategy, which ' +
            'spends no credits and needs no platform key.',
        }
      );
    },
  });

  registry.register({
    name: 'jeeta.list_strategy_actions',
    description:
      "List the strategy's ActionPlan — the concrete actions the strategist proposed (find prospects, publish content, engage a community, set up an ad campaign), highest priority first, each with its rationale, payload and status. PROPOSED actions are the ones waiting on a decision.",
    domain: 'strategy',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z
        .enum(ACTION_STATUSES)
        .optional()
        .describe('Restrict to one status. Use PROPOSED to see what still needs a decision.'),
    }),
    handler: async (ctx, args) =>
      deps.strategy.listActions(ctx.workspaceId, typeof args.status === 'string' ? { status: args.status } : undefined),
  });

  registry.register({
    name: 'jeeta.approve_strategy_action',
    description:
      'Approve one PROPOSED strategy action AND run it immediately. Depending on the action this starts a paid prospect-research run, spends AI credits writing content, provisions a paused ad campaign, or posts live to a connected community — so in APPROVAL mode this queues for a human, while in AUTONOMOUS mode it runs immediately. Returns the action re-read after execution, so check its status (DONE/FAILED) and resultRef for the real outcome.',
    domain: 'strategy',
    scopes: ['settings.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'STRATEGY_ACTION',
    resourceType: 'strategy_action',
    resourceIdFrom: (args) => (typeof args.actionId === 'string' ? args.actionId : undefined),
    inputSchema: z.object({
      actionId: z
        .string()
        .min(1)
        .describe('Id of the action to approve, from jeeta.list_strategy_actions. Must still be PROPOSED.'),
    }),
    handler: async (ctx, args) => {
      const actionId = String(args.actionId ?? '');
      const approved = await deps.strategy.approveAction(ctx.workspaceId, actionId);
      // `approveAction` snapshots the row BEFORE handing it to the orchestrator,
      // so its return value always reads `APPROVED` / `resultRef: null` even
      // when the executor has since finished or failed (the orchestrator
      // records failures on the row — reason in `resultRef` as `error:…` —
      // and never rethrows). Re-read through the same workspace-scoped service
      // so the agent reports the outcome that actually happened.
      const fresh = (await deps.strategy.listActions(ctx.workspaceId)) as Array<{ id: string }>;
      return fresh.find((a) => a.id === actionId) ?? approved;
    },
  });

  registry.register({
    name: 'jeeta.dismiss_strategy_action',
    description:
      'Dismiss a proposed (or approved-but-not-yet-run) strategy action so it drops out of the plan. Nothing is executed, spent or sent. Actions that have already run cannot be dismissed.',
    domain: 'strategy',
    // Deferred (spec §3): the tidy-up half of the approve/dismiss pair — a
    // model that has just listed the plan can find it by name.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      actionId: z.string().min(1).describe('Id of the action to dismiss, from jeeta.list_strategy_actions.'),
    }),
    handler: async (ctx, args) => deps.strategy.dismissAction(ctx.workspaceId, String(args.actionId ?? '')),
  });

  registry.register({
    name: 'jeeta.synthesize_strategy',
    description:
      "Re-run the strategist: research the market again, rewrite the brief and replace the ActionPlan, folding in what the previous plan's actions actually produced. This SPENDS AI credits and live web-scraping money — in APPROVAL mode this queues for a human; in AUTONOMOUS mode it runs immediately. It also DELETES the current ActionPlan and replaces it — any action not yet approved is lost.",
    domain: 'strategy',
    // Deferred (spec §3): a heavyweight, occasional act (minutes of wall clock,
    // real money) — not a per-turn action.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'AI_SPEND',
    inputSchema: z.object({}),
    handler: async (ctx) =>
      // `StrategyFeedbackService.refresh` — NOT `StrategySynthesisService
      // .synthesize` — is the workspace-only entry point: it resolves the
      // workspace's intake session (which an agent has no way to obtain an id
      // for), builds the outcome summary and calls synthesis with it. Credits
      // (`strategy.synthesize`, 8) are reserved and refunded INSIDE synthesis;
      // nothing is re-metered here.
      deps.feedback.refresh(ctx.workspaceId),
  });

  registry.register({
    name: 'jeeta.set_strategy_autonomy',
    description:
      'Set how the strategy lane behaves: SHADOW (the strategist only observes and proposes) or ASSISTED (proposals wait for a human approval before running). Both keep a human in the loop. The fully autonomous lane cannot be set from here at all — an agent must not widen its own authority; ask the workspace owner to change it in the panel. Requires a human approval.',
    domain: 'strategy',
    // Deferred (spec §3): a one-off policy switch, not day-to-day work.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'TARGET_CHANGE',
    inputSchema: z.object({
      level: z
        .enum(SETTABLE_AUTONOMY)
        .describe(
          'SHADOW = propose only, never act. ASSISTED = a human approves each action before it runs (the default). AUTONOMOUS is deliberately not offered here.',
        ),
    }),
    handler: async (ctx, args) => {
      const level = String(args.level ?? '');
      // Belt to the schema's braces. The schema is the load-bearing control —
      // an enum with no AUTONOMOUS member cannot be talked past by any write
      // mode, by an approved replay, or by a future edit that flips
      // `requiresApproval` to false. This second check exists so that a
      // refactor which loosens the schema (or a caller that reaches the handler
      // directly, as the tool specs do) still cannot escalate, and so the
      // refusal is a sentence rather than a schema error.
      if (!(SETTABLE_AUTONOMY as readonly string[]).includes(level)) {
        throw new BadRequestException(
          `autonomy level "${level}" cannot be set through MCP. AUTONOMOUS removes the human approval gate from the strategy lane, which an agent must not grant itself — a workspace owner sets it in the panel. Allowed here: ${SETTABLE_AUTONOMY.join(', ')}.`,
        );
      }
      return deps.strategy.setAutonomy(ctx.workspaceId, level);
    },
  });

  registry.register({
    name: 'jeeta.submit_strategy',
    description:
      "Save a marketing strategy YOU wrote yourself, instead of paying the platform's model to write one for you. " +
      'This is how a connected Claude gives a workspace its FIRST strategy: you already hold the brand context ' +
      '(jeeta.get_brand_profile, jeeta.search_brand_knowledge, jeeta.get_workspace_info), so jeeta.synthesize_strategy ' +
      'would only be you asking the server to ask another model — a round trip that costs the workspace AI credits ' +
      "and stops working entirely whenever the platform's own key is dry. This call spends NOTHING: no credits, no " +
      'model call, no research money. What it writes is the same row a synthesis writes — ACTIVE, version 1, the ' +
      'ASSISTED lane, and an ActionPlan of PROPOSED actions — so the strategy console, the orchestrator and the ' +
      'setup list read it exactly as if the platform had produced it. REFUSALS, all whole-submission: a workspace ' +
      'that ALREADY has a strategy (this only creates the first one — replacing deletes the existing ActionPlan ' +
      'including the DONE actions that point at what they produced, so it stays with jeeta.synthesize_strategy); ' +
      'an archetype outside the listed set; a brief missing any section; an empty ActionPlan — the plan is what the ' +
      'operator approves and the system executes. THIS CALL EXECUTES NOTHING: every action it writes is PROPOSED. ' +
      'Two things can move a PROPOSED action afterwards — jeeta.approve_strategy_action, which runs that action ' +
      '(paid prospect research, a live community post, an ad shell) there and then; and the hourly apply cron, but ' +
      'only on a workspace whose strategy autonomy lane is AUTONOMOUS, which this tool cannot set and a strategy ' +
      'it creates is never born into (the row starts ASSISTED). Whether approving is a human ' +
      "decision depends on the workspace's MCP write mode, not on this tool: in APPROVAL mode the approve call " +
      'queues a card for a person; in AUTONOMOUS mode the broker runs it inline for you. You cannot set the ' +
      'strategy autonomy lane from here. ONE LIMITATION, worth knowing before you choose this over the interview: ' +
      'it writes no intake session, and re-synthesis reads one — so on a workspace whose strategy came from here ' +
      "and that never ran the panel's strategy interview, jeeta.synthesize_strategy answers " +
      "{skipped:'no-intake-session'}, and no other MCP tool edits a stored brief. You can drop stale items with " +
      'jeeta.dismiss_strategy_action, but rewriting the brief means the owner running that interview in the panel ' +
      '(Strategy > start), which needs the platform model this tool exists to do without.',
    domain: 'strategy',
    // Deferred (spec §3), like every tool added since the advertised surface
    // hit its 45-tool ceiling — the rule there is that a wave wanting room
    // DEFERS something rather than raising the number, and writing a strategy
    // is a once-per-workspace act that does not earn another tool's slot.
    // `jeeta.get_strategy` stays this domain's listed read, and it is what a
    // model calls first: the "no strategy yet" answer it returns is the moment
    // this tool is wanted, and `jeeta.find_tools` reaches it by name.
    defer: true,
    // Same scope the panel's own strategy writes demand.
    scopes: ['settings.manage'],
    // WRITE, and ungated on purpose. It creates a row where there was none and
    // executes nothing — every action it writes is PROPOSED, and moving one is
    // a SEPARATE call to `jeeta.approve_strategy_action`, which is SPEND. What
    // that buys depends on the write mode and is worth stating plainly: in
    // APPROVAL mode the approve queues a card for a person; in AUTONOMOUS mode
    // the broker runs it inline (ALWAYS_APPROVED_RISKS is DESTRUCTIVE only), so
    // there the guarantee is only that this submit did not run anything by
    // itself. Gating THIS instead would mean the setup list can NAME the fix
    // and still not have it applied until a human opens the approvals screen,
    // which is the exact failure `readiness-tool-promises.spec.ts` exists to
    // prevent. `d4-approval-gate.spec.ts` pins what is actually true of this
    // tool through the real broker, in both modes.
    requiresApproval: false,
    risk: 'WRITE',
    inputSchema: z.object({
      archetype: z
        .enum(ARCHETYPE_KEYS)
        .describe(
          'The business archetype. It drives the channel priors and the lead approach (B2B prospecting vs B2C ' +
            'audience building), so pick the closest real fit; OTHER is the honest answer when none applies.',
        ),
      // The schema `validateBrief` parses, imported rather than restated: a
      // submission this tool accepts therefore cannot fail validation on the
      // way in, and the two contracts cannot drift apart.
      brief: marketingStrategyBriefSchema.describe(
        'The strategy itself: identity{product,voice,positioning,usp}, audience (the ICP), ' +
          'channels[{key,fitScore 0-1,rationale}] — name the SPECIFIC community in the rationale where there is one ' +
          '(a subreddit, a Discord, a forum) — contentPillars[{title,angle,formats[],tone}], goals{objective,kpis[]}, ' +
          'budget (free text, e.g. "$200/mo ads + organic"), competitors[]. Every section is required and is read in ' +
          'a panel, so keep each field tight.',
      ),
      actions: z
        .array(
          z.object({
            kind: z
              .enum(ACTION_KINDS)
              .describe('Which executor runs this action once a human approves it.'),
            title: z.string().min(1).max(200).describe('What the operator sees on the approval card.'),
            rationale: z
              .string()
              .min(1)
              .max(2000)
              .describe('Why this action serves the strategy. This is the line the operator approves on.'),
            payload: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Executor-ready config for this kind — e.g. COMMUNITY_ENGAGE takes ' +
                  '{channelKey, community, title, angle, tone, format}. Defaults to {}.',
              ),
            priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Defaults to MEDIUM.'),
          }),
        )
        .min(1)
        .max(MAX_ACTIONS)
        .describe(
          'The prioritized ActionPlan. Required and never empty — it is what the operator approves and the system ' +
            `executes. At most ${MAX_ACTIONS}; a longer plan is refused here rather than silently truncated.`,
        ),
    }),
    handler: async (ctx, args) =>
      deps.synthesis.submitStrategy(ctx.workspaceId, {
        archetype: args.archetype,
        brief: args.brief,
        actions: args.actions,
      }),
  });
}
