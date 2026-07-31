import { z } from 'zod';
import { SegmentsService } from '../../services/segments.service';
import { TagsService } from '../../services/tags.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface CrmReadToolDeps {
  segments: SegmentsService;
  tags: TagsService;
}

/**
 * Faz 5 D1 — the two read helpers the rest of the CRM surface refers to.
 *
 * Segments (saved audience definitions) and tags are the vocabulary a caller
 * needs before it can talk about "the Istanbul restaurants segment" or "the
 * hot-lead tag": both are workspace-defined, so an agent cannot know them
 * without asking. Both services scope by `workspaceId` unconditionally and take
 * no principal — visibility is workspace-wide for both in the panel too.
 *
 * Read-only on purpose. Creating a segment means authoring a filter DEFINITION
 * that later drives campaign audiences; creating tags is how bulk membership
 * gets rewritten. Both are write surfaces that belong with the campaign lane
 * (D2/D3), not with D1's per-record CRM edits.
 *
 * Scoped `contacts.read`, matching the REST controllers' write gate family
 * (`contacts.write` for every segment/tag mutation) — these are contact-data
 * taxonomies, not lead records.
 */
export function registerCrmReadTools(registry: McpToolRegistry, deps: CrmReadToolDeps): void {
  registry.register({
    name: 'jeeta.list_segments',
    description:
      'List the saved contact segments (audience definitions) in this workspace, newest first. Read-only.',
    domain: 'contacts',
    // Deferred (spec §3): A niche lookup used when building an audience, not on a normal turn.
    defer: true,
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.segments.list(ctx.workspaceId),
  });

  registry.register({
    name: 'jeeta.list_tags',
    description:
      'List the lead/contact tags defined in this workspace, each with how many records carry it. Read-only.',
    domain: 'contacts',
    // Deferred (spec §3): A niche lookup used when building an audience, not on a normal turn.
    defer: true,
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.tags.list(ctx.workspaceId),
  });
}
