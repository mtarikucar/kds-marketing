import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface WorkspaceToolDeps {
  entitlements: EntitlementsService;
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
}
