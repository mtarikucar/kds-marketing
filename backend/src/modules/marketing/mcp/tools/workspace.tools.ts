import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { MarketingUsersService } from '../../services/marketing-users.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface WorkspaceToolDeps {
  entitlements: EntitlementsService;
  users: MarketingUsersService;
}

/**
 * Workspace info is a pure read over the workspace's effective plan
 * entitlements (package, subscription status, quotas/limits, enabled
 * features) — `EntitlementsService.getEffective` is an existing,
 * already-computed read path (used by every `@RequiresFeature` gate), so
 * this tool reuses it rather than adding a new service method.
 */
export function registerWorkspaceTools(registry: McpToolRegistry, deps: WorkspaceToolDeps): void {
  registry.register({
    name: 'jeeta.get_workspace_info',
    description:
      'Get this workspace\'s effective plan info: package, subscription status, quotas/limits and which features are enabled. Read-only.',
    domain: 'workspace',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.entitlements.getEffective(ctx.workspaceId),
  });

  /**
   * The id-resolution tool the assignment surface was missing.
   *
   * Four tools take an `assignedToId` — create_task (REQUIRED on an API-key
   * session, which has no human caller to default to), assign_lead,
   * assign_conversation, create_opportunity — and nothing in the catalogue
   * returned a user id. So a connected agent could be told "assignedToId is
   * required" and have no way to satisfy it: creating a task was impossible,
   * not merely awkward. Found by running the real flow on a customer lead.
   *
   * Read-only and deliberately narrow: ids, names, role and status of this
   * workspace's members. `findAll` already excludes SYSTEM memberships (the
   * research/automation principals), so those never leak into an assignment
   * picker. Phones/emails come from the same existing read the panel uses —
   * this is teammate directory data, not customer PII.
   */
  registry.register({
    name: 'jeeta.list_team',
    description:
      "List this workspace's team members with their user ids, names, role and status. Use it to resolve an " +
      'assignedToId before calling jeeta.create_task (which requires one), jeeta.assign_lead, ' +
      'jeeta.assign_conversation or jeeta.create_opportunity. Read-only.',
    domain: 'workspace',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      activeOnly: z
        .boolean()
        .optional()
        .describe('Only members whose membership is ACTIVE — the ones an assignment will actually accept. Defaults to true.'),
    }),
    handler: async (ctx, args) => {
      const all = await deps.users.findAll(ctx.workspaceId);
      const activeOnly = args.activeOnly !== false;
      return all
        .filter((u) => (activeOnly ? u.status === 'ACTIVE' : true))
        .map((u) => ({
          id: u.id,
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
          email: u.email,
          role: u.role,
          status: u.status,
        }));
    },
  });
}
