import { z } from 'zod';
import { AdAccountService } from '../../ads/ad-account.service';
import { AdManagementService } from '../../ads/ad-management.service';
import { BudgetManagementService } from '../../budget/budget-management.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface AdsToolDeps {
  /** Connected ad accounts + pulled provider metrics (spend/impressions/clicks/leads/revenue). */
  accounts: AdAccountService;
  /** The Growth Autopilot's budget records (GrowthBudget + allocations). */
  budgets: BudgetManagementService;
  /** Meta/TikTok/LinkedIn/Google campaign & ad-set management (status + budget writes). */
  ads: AdManagementService;
}

/**
 * Ads tools span three services on purpose — there is no single "ads"
 * service in this codebase:
 *  - `jeeta.get_ad_performance` reads the pulled AdMetric rollups
 *    (AdAccountService.getMetrics) — spend/impressions/clicks/leads/revenue.
 *  - `jeeta.get_budget` reads the workspace's Growth Autopilot budget
 *    (BudgetManagementService) — the planning/allocation record, distinct
 *    from a live ad entity's daily cap.
 *  - `jeeta.reallocate_budget` changes a campaign/ad-set's live daily budget
 *    (AdManagementService.setDailyBudget) — real ad spend, hence SPEND risk
 *    and a mandatory BUDGET_REALLOCATION approval gate.
 */
export function registerAdsTools(registry: McpToolRegistry, deps: AdsToolDeps): void {
  registry.register({
    name: 'jeeta.list_ad_accounts',
    description:
      'List the ad accounts connected to this workspace (id, provider, display name, status, currency). ' +
      'jeeta.reallocate_budget REQUIRES an adAccountId and nothing else returned one. Never returns tokens. ' +
      'Read-only.',
    domain: 'ads',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      const rows = (await deps.accounts.list(ctx.workspaceId)) as Array<Record<string, unknown>>;
      return rows.map((a) => ({
        id: a.id,
        provider: a.provider,
        displayName: a.displayName ?? null,
        status: a.status ?? null,
        currency: a.currency ?? null,
      }));
    },
  });

  registry.register({
    name: 'jeeta.get_ad_performance',
    description:
      'Get aggregated ad performance (spend, impressions, clicks, leads, revenue) for this workspace over a date range, totals + by-day + by-provider. Read-only.',
    domain: 'ads',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      from: z.string().min(1).describe('Inclusive start date, ISO 8601 (YYYY-MM-DD).'),
      to: z.string().min(1).describe('Inclusive end date, ISO 8601 (YYYY-MM-DD).'),
      provider: z
        .enum(['META', 'TIKTOK', 'LINKEDIN', 'GOOGLE'])
        .optional()
        .describe('Restrict to one ad provider. Omit for all connected providers.'),
    }),
    handler: async (ctx, args) =>
      deps.accounts.getMetrics(
        ctx.workspaceId,
        String(args.from ?? ''),
        String(args.to ?? ''),
        typeof args.provider === 'string' ? args.provider : undefined,
      ),
  });

  registry.register({
    name: 'jeeta.get_budget',
    description:
      'Get the workspace\'s Growth Autopilot budget (total amount, target ROAS/CAC, channel allocations) by id, or list every budget when no id is given. Read-only.',
    domain: 'ads',
    // Deferred in D5 (spec §3) — the other half of the two advertised slots
    // that paid for the commerce/courses/reviews domains. A Growth Autopilot
    // budget is opt-in provisioning: for every workspace without one this tool
    // returns an empty list, and it was occupying context in every session to
    // do it. `jeeta.get_ad_performance` stays the ads domain's advertised read,
    // and `jeeta.reallocate_budget` (which needs an id from here) is itself a
    // gated, deliberate action a model reaches for by name.
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      budgetId: z
        .string()
        .optional()
        .describe('Growth budget id to fetch. Omit to list every budget in the workspace.'),
    }),
    handler: async (ctx, args) => {
      const budgetId = typeof args.budgetId === 'string' ? args.budgetId : undefined;
      return budgetId ? deps.budgets.get(ctx.workspaceId, budgetId) : deps.budgets.list(ctx.workspaceId);
    },
  });

  registry.register({
    name: 'jeeta.reallocate_budget',
    description:
      'Change the live daily budget of one campaign or ad set on a connected ad account. This spends real money, so in APPROVAL mode it is queued for a human instead of applying immediately.',
    domain: 'ads',
    scopes: ['settings.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'BUDGET_REALLOCATION',
    // Dedupe key: the ad account + entity together identify the live budget
    // being changed (entityId alone is not guaranteed unique across ad
    // accounts) — see McpBrokerService.invoke()'s supersede sweep.
    resourceType: 'ad_entity',
    resourceIdFrom: (args) =>
      typeof args.adAccountId === 'string' && typeof args.entityId === 'string'
        ? `${args.adAccountId}:${args.entityId}`
        : undefined,
    inputSchema: z.object({
      adAccountId: z.string().min(1).describe('The connected ad account id (not the campaign id) that owns the entity.'),
      entityId: z.string().min(1).describe('Campaign or ad set id to change the daily budget for.'),
      dailyBudgetMajor: z
        .number()
        .positive()
        .describe('New daily budget in major currency units (e.g. 50.00 = 50 TRY/USD), not cents.'),
    }),
    handler: async (ctx, args) =>
      deps.ads.setDailyBudget(
        ctx.workspaceId,
        String(args.adAccountId ?? ''),
        String(args.entityId ?? ''),
        Number(args.dailyBudgetMajor),
      ),
  });
}
