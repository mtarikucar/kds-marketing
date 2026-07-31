import { z } from 'zod';
import { BrandBrainService } from '../../brand-brain/brand-brain.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface BrandToolDeps {
  brand: BrandBrainService;
}

/**
 * Brand knowledge search is a pure read over workspace-scoped chunks, so it
 * needs no approval gate and no user principal — `workspaceId` alone is
 * sufficient tenancy.
 */
export function registerBrandTools(registry: McpToolRegistry, deps: BrandToolDeps): void {
  registry.register({
    name: 'jeeta.search_brand_knowledge',
    description:
      'Search the workspace brand profile (tone of voice, positioning, products, policies) and return cited passages. Call this before writing any customer-facing copy.',
    domain: 'brand',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe('Free-text search query, e.g. "tone of voice", "refund policy", "target audience".'),
    }),
    handler: async (ctx, args) =>
      deps.brand.search(ctx.workspaceId, { queryText: String(args.query ?? '') }),
  });
}
