import { z } from 'zod';
import { LeadFilterDto } from '../../dto/lead-filter.dto';
import { MarketingLeadsService } from '../../services/marketing-leads.service';
import { McpToolRegistry } from '../mcp-tool-registry';

/**
 * `MarketingLeadsService.findAll` takes a (userId, userRole) principal, but an
 * API-key MCP session has no user. Rather than silently borrow an identity, we
 * call with an explicit, named placeholder — and name it for exactly what it
 * grants, no more:
 *
 * - Inside `findAll`, `userRole` is checked only for `=== 'REP'`; every other
 *   value (MANAGER, OWNER, ...) falls through the same branch and behaves
 *   identically. So `'MANAGER'` here is not an authority grant — it is just
 *   "not REP". Using `'REP'` would be actively wrong: it pins visibility to
 *   `assignedToId === MCP_NON_REP_PRINCIPAL.userId`, a synthetic id that owns
 *   no leads, so the tool would silently return zero rows.
 * - The synthetic `userId` is read-only for this call path: it only ever
 *   reaches `where.assignedToId` in a read query. It never reaches anything
 *   that writes, assigns, or attributes a lead.
 * - Tenant isolation does not depend on this principal — `findAll` scopes by
 *   `workspaceId` unconditionally, and no role value widens that.
 *
 * Faz 3 (OAuth, which IS user-bound) should replace this with the real caller.
 */
export const MCP_NON_REP_PRINCIPAL = { userId: 'mcp-service-principal', role: 'MANAGER' } as const;

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
        // `inputSchema` above is hand-kept in sync with `LeadFilterDto` field
        // for field; this cast trusts that correspondence rather than
        // checking it structurally. Edit both sides together.
        args as unknown as LeadFilterDto,
        ctx.userId ?? MCP_NON_REP_PRINCIPAL.userId,
        MCP_NON_REP_PRINCIPAL.role,
      ),
  });
}
