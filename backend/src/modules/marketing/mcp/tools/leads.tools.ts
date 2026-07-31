import { z } from 'zod';
import { LeadFilterDto } from '../../dto/lead-filter.dto';
import { MarketingLeadsService } from '../../services/marketing-leads.service';
import { MCP_NON_REP_PRINCIPAL, visibilityPrincipal } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

/**
 * `MarketingLeadsService.findAll` takes a (userId, userRole) principal.
 *
 * Faz 3 SOLVED the user-bound half: an OAuth session names the human who
 * consented, and `McpInvokerService` resolves the role they hold in this
 * workspace from their ACTIVE membership on every call. So a REP who connects
 * Claude sees, through the tool, exactly the leads they see in the UI — their
 * own — and a demotion or removal since consent takes effect on the next call
 * (removal is refused outright, in the invoker).
 *
 * What remains is the API-KEY session, which has no user by construction: the
 * key belongs to a workspace. Rather than silently borrow an identity, that
 * path calls with the explicit, named `MCP_NON_REP_PRINCIPAL` placeholder —
 * see `mcp-principal.service.ts` for why it is read-only-safe and why the
 * WRITE lane (Faz 5 D1) must resolve a real user instead.
 *
 * Re-exported here because the constant moved to `mcp-principal.service.ts`
 * when the write lane needed it; existing importers keep working.
 */
export { MCP_NON_REP_PRINCIPAL };

export interface LeadsToolDeps {
  leads: MarketingLeadsService;
}

export function registerLeadsTools(registry: McpToolRegistry, deps: LeadsToolDeps): void {
  registry.register({
    name: 'jeeta.search_leads',
    description:
      'Search leads in this workspace by free text, status, source, city/region, priority, assignment or date range. Returns a paginated list. Read-only.',
    domain: 'leads',
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
    handler: async (ctx, args) => {
      // Paired deliberately: a real user must be judged by their REAL role (a
      // REP's `findAll` narrows to their own rows), and the placeholder id must
      // keep the placeholder's "not REP" role or it would match no leads at all.
      const actor = visibilityPrincipal(ctx);
      return deps.leads.findAll(
        ctx.workspaceId,
        // `inputSchema` above is hand-kept in sync with `LeadFilterDto` field
        // for field; this cast trusts that correspondence rather than
        // checking it structurally. Edit both sides together.
        args as unknown as LeadFilterDto,
        actor.userId,
        actor.role,
      );
    },
  });
}
