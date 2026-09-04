import { z } from 'zod';
import { WorkspaceReadinessService } from '../../services/workspace-readiness.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ReadinessToolDeps {
  readiness: WorkspaceReadinessService;
}

/**
 * "What is this workspace still missing, and which of it can I fix myself?"
 *
 * The panel and the agent read the SAME computation, deliberately. Two lists of
 * what a workspace needs is how the one a human is looking at and the one an
 * agent is working from stop agreeing — and the disagreement is invisible,
 * because each looks right on its own screen.
 *
 * `mcpTool` on each gap is the point of exposing this at all. Without it the
 * answer is a list of complaints; with it, the agent can read the gap and act
 * on it in the same turn, and the ones it must NOT act on are marked by a null
 * rather than left to its judgement — a payment provider's secret key belongs
 * to the person who holds it, and a tool that wrote one would be a tool that
 * can redirect money.
 */
export function registerReadinessTools(registry: McpToolRegistry, deps: ReadinessToolDeps): void {
  registry.register({
    name: 'jeeta.get_setup_readiness',
    description:
      'List everything this workspace still needs before the marketing engine runs at full strength — brand profile, strategy, workflows, research, connected channels, sending domain, products, tax rates, payment provider, order forms, landing pages, email templates, an ACTIVE campaign, content concepts and wallet balances. Each gap names the tool that can close it (`mcpTool`), or null when only a human can. Call this first when asked to "finish setting up" or "make the workspace work properly", and again afterwards to confirm what actually closed.',
    domain: 'workspace',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      /**
       * The whole list is the useful answer in most turns — an agent asked to
       * finish setup needs to see what is already done as well, or it re-does
       * it. The filter exists for the follow-up call.
       */
      onlyGaps: z
        .boolean()
        .optional()
        .describe('When true, return only the items that are MISSING or need ATTENTION.'),
    }),
    handler: async (ctx, args) => {
      const r = await deps.readiness.get(ctx.workspaceId);
      const items = args.onlyGaps ? r.items.filter((i) => i.state !== 'READY') : r.items;
      return {
        ...r,
        items,
        // Said out loud rather than left to be inferred from a count: an engine
        // missing its inputs does not fail, it under-performs quietly, which is
        // the failure nobody reports.
        note:
          r.ready === r.total
            ? 'Every item is ready.'
            : `${r.total - r.ready} of ${r.total} items are not ready. Until they are, parts of the engine will run at reduced strength or not at all — see each item's id.`,
      };
    },
  });
}
