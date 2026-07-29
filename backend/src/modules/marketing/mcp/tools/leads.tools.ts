import { z } from 'zod';
import { LeadFilterDto } from '../../dto/lead-filter.dto';
import { MarketingLeadsService } from '../../services/marketing-leads.service';
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
 * path calls with an explicit, named placeholder — named for exactly what it
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
        // Paired with `userId` deliberately: a real user must be judged by
        // their REAL role (a REP's `findAll` narrows to their own rows), and
        // the placeholder id must keep the placeholder's "not REP" role or it
        // would match no leads at all. Taking `ctx.userRole` while falling
        // back to the synthetic id would silently return zero rows.
        ctx.userId && ctx.userRole ? ctx.userRole : MCP_NON_REP_PRINCIPAL.role,
      ),
  });
}
