import { z } from 'zod';
import { AnalyticsService, DateRange } from '../../analytics/analytics.service';
import { AiUsageStatsService } from '../../ai/ai-usage-stats.service';
import { VendorSpendReportService } from '../../wallet/vendor-spend-report.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface AnalyticsToolDeps {
  analytics: AnalyticsService;
  aiUsage: AiUsageStatsService;
  vendorSpend: VendorSpendReportService;
}

/**
 * Analytics tools are pure reads over workspace-scoped aggregates, so they need
 * no approval gate and no user principal — `workspaceId` alone is sufficient
 * tenancy.
 */
export function registerAnalyticsTools(registry: McpToolRegistry, deps: AnalyticsToolDeps): void {
  registry.register({
    name: 'jeeta.get_funnel',
    description:
      'Get the lead funnel for a date range: counts per stage from first touch to won. Use for "how is the pipeline doing" questions.',
    domain: 'analytics',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      from: z.string().optional().describe('Inclusive start date, ISO 8601 (YYYY-MM-DD).'),
      to: z.string().optional().describe('Inclusive end date, ISO 8601 (YYYY-MM-DD).'),
    }),
    handler: async (ctx, args) => {
      const range: DateRange = {
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
      };
      return deps.analytics.funnel(ctx.workspaceId, range);
    },
  });

  registry.register({
    name: 'jeeta.get_ai_usage',
    description:
      'Where this workspace spent AI money: measured input/output tokens and real vendor cost per action and model, plus a daily curve. `costRatio` above 1.0 means the action bills fewer credits than it costs to run. Use it to answer "why is the AI bill high" and "which action should be cheaper or on a smaller model". Read-only.',
    domain: 'analytics',
    // Deferred: an operator/billing question, not part of daily marketing work.
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe('How many days back to include. Defaults to 30.'),
      daily: z
        .boolean()
        .optional()
        .describe('Also return the per-day totals, for spotting the day it ran away.'),
    }),
    handler: async (ctx, args) => {
      const days = typeof args.days === 'number' ? args.days : 30;
      const breakdown = await deps.aiUsage.breakdown(ctx.workspaceId, days);
      if (args.daily !== true) return breakdown;
      return { ...breakdown, daily: await deps.aiUsage.daily(ctx.workspaceId, days) };
    },
  });

  registry.register({
    name: 'jeeta.get_vendor_spend',
    description:
      'What this workspace spent with OUTSIDE vendors — NetGSM SMS/voice, Meta WhatsApp, fal.ai media, Firecrawl pages, Apify runs — as opposed to Anthropic tokens (use get_ai_usage for those). `byChannel` is what was recorded; `rates` and `unmetered` are what CAN be recorded. A unit in `unmetered` has no tariff, so its cost is settled at nothing and leaves no ledger row at all — it reads as 0 TRY everywhere while still appearing on the vendor invoice. Use it to answer "what are our costs" and "is anything we pay for invisible". Read-only.',
    domain: 'analytics',
    // Deferred for the same reason as get_ai_usage: an operator/billing
    // question, not part of daily marketing work.
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe('How many days back to include. Defaults to 30.'),
    }),
    handler: async (ctx, args) => {
      const days = typeof args.days === 'number' ? args.days : 30;
      return deps.vendorSpend.report(ctx.workspaceId, days);
    },
  });
}
