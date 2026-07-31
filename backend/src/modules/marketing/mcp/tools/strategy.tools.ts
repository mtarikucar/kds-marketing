import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { StrategyService } from '../../strategy/strategy.service';
import { StrategyFeedbackService } from '../../strategy/feedback/strategy-feedback.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface StrategyToolDeps {
  strategy: StrategyService;
  /**
   * Re-synthesis runs through the FEEDBACK service, never
   * `StrategySynthesisService.synthesize` directly — see
   * `jeeta.synthesize_strategy` below for why.
   */
  feedback: StrategyFeedbackService;
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
 * neither is recoverable by reading the audit log afterwards — which is exactly
 * the `SPEND` definition in the broker's `ALWAYS_APPROVED_RISKS`. So this tool
 * is queued for a human in EVERY write mode, autonomous included.
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
      // and where the human fixes it.
      return (
        strategy ?? {
          strategy: null,
          message:
            'This workspace has no synthesized strategy yet. Run the strategy interview in the panel (Strategy > start) first; the strategy is synthesized from that intake session.',
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
      'Approve one PROPOSED strategy action AND run it immediately. Depending on the action this starts a paid prospect-research run, spends AI credits writing content, provisions a paused ad campaign, or posts live to a connected community — so it always requires a human approval, in every write mode including autonomous. Returns the action re-read after execution, so check its status (DONE/FAILED) and resultRef for the real outcome.',
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
      "Re-run the strategist: research the market again, rewrite the brief and replace the ActionPlan, folding in what the previous plan's actions actually produced. This SPENDS AI credits and live web-scraping money, so it always requires a human approval, in every write mode including autonomous. It also DELETES the current ActionPlan and replaces it — any action not yet approved is lost.",
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
}
