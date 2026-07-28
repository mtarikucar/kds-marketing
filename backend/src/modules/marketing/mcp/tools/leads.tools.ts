import { z } from 'zod';
import { LeadFilterDto } from '../../dto/lead-filter.dto';
import { MarketingLeadsService } from '../../services/marketing-leads.service';
import { McpToolRegistry } from '../mcp-tool-registry';

/**
 * `MarketingLeadsService.findAll` applies row-level visibility from a user
 * principal, but an API-key MCP session has no user. Until Faz 3 (OAuth, which
 * IS user-bound) we call as an explicit, named service principal rather than
 * silently borrowing an owner identity. Tenancy is still enforced — every query
 * is workspace-scoped — but assignee-level filtering is intentionally bypassed
 * for API-key callers. Narrow this the moment a real user id is available.
 */
export const MCP_SERVICE_PRINCIPAL = { userId: 'mcp-service-principal', role: 'OWNER' } as const;

export interface LeadsToolDeps {
  leads: MarketingLeadsService;
}

export function registerLeadsTools(registry: McpToolRegistry, deps: LeadsToolDeps): void {
  registry.register({
    name: 'jeeta.search_leads',
    description:
      'Search leads in this workspace by free text, status, source, city/region, priority, assignment or date range. Returns a paginated list. Read-only.',
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      search: z.string().optional().describe('Free-text match against lead name, phone, email, etc.'),
      status: z.string().optional().describe('Lead pipeline status/stage to filter by.'),
      city: z.string().optional().describe('City filter.'),
      region: z.string().optional().describe('Region filter.'),
      source: z.string().optional().describe('Lead source filter (e.g. "referral", "meta_ads").'),
      businessType: z.string().optional().describe('Business type filter.'),
      assignedToId: z.string().optional().describe('Filter to leads assigned to this user id.'),
      assignmentStatus: z
        .enum(['unassigned', 'assigned', 'mine'])
        .optional()
        .describe('Coarse assignment filter: unassigned, assigned to anyone, or assigned to the caller.'),
      priority: z.string().optional().describe('Lead priority filter.'),
      dateFrom: z.string().optional().describe('Inclusive start date, ISO 8601 (YYYY-MM-DD).'),
      dateTo: z.string().optional().describe('Inclusive end date, ISO 8601 (YYYY-MM-DD).'),
      sortBy: z.string().optional().describe('Field name to sort results by.'),
      sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
      page: z.number().int().min(1).optional().describe('Page number, 1-based (default 1).'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, max 100 (default varies).'),
    }),
    handler: async (ctx, args) =>
      deps.leads.findAll(
        ctx.workspaceId,
        args as unknown as LeadFilterDto,
        ctx.userId ?? MCP_SERVICE_PRINCIPAL.userId,
        MCP_SERVICE_PRINCIPAL.role,
      ),
  });
}
