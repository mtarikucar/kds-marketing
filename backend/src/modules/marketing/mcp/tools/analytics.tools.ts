import { z } from 'zod';
import { AnalyticsService, DateRange } from '../../analytics/analytics.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface AnalyticsToolDeps {
  analytics: AnalyticsService;
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
}
