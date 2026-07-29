import { z } from 'zod';
import { SocialPlannerService } from '../../social-planner/social-planner.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface SocialToolDeps {
  social: SocialPlannerService;
}

const POST_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED'] as const;

/**
 * Social planner tools: two ungated operations (list, draft) and one
 * approval-gated write (publish). `SocialPlannerService.listPosts` is a flat,
 * unfiltered list — it has no server-side status filter — so
 * `jeeta.list_scheduled_posts` filters the result client-side, defaulting to
 * SCHEDULED (matching the tool's name) with an optional override so a caller
 * can still ask for drafts/published/failed. `jeeta.draft_social_post`
 * creates a DRAFT row with no external side effect, so it is deliberately
 * ungated (no approval), but it is still a write: the REST equivalent
 * (`SocialPlannerController.createPost`) is gated `@RequirePermission('campaigns.send')`,
 * so the MCP tool mirrors that rather than the weaker `campaigns.read` — a
 * read-only key must not be able to create rows. `jeeta.publish_social_post`
 * calls `publishNow`, which reaches a real audience, so it is registered
 * `requiresApproval: true` / `approvalKind: 'PUBLISH'` — the broker enqueues a
 * human approval instead of running the handler inline unless the
 * workspace's writeMode is AUTONOMOUS.
 *
 * `jeeta.draft_social_post` is scoped `campaigns.write`, not `campaigns.send`:
 * a caller that may only prepare content should not be forced to also carry
 * the authority that publishes it to a real audience. This is narrower than
 * the REST equivalent (`SocialPlannerController.createPost`), which is still
 * gated `@RequirePermission('campaigns.send')` — that REST gate is untouched
 * here; only the MCP tool's own scope requirement moved to the new granular
 * `campaigns.write` permission (see `roles/permissions.ts`).
 */
export function registerSocialTools(registry: McpToolRegistry, deps: SocialToolDeps): void {
  registry.register({
    name: 'jeeta.list_scheduled_posts',
    description:
      'List social posts in this workspace, newest first. Defaults to SCHEDULED (upcoming) posts; pass status to see drafts, publishing, published or failed posts instead. Read-only.',
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z
        .enum(POST_STATUSES)
        .optional()
        .describe('Restrict to posts in this status. Defaults to SCHEDULED when omitted.'),
    }),
    handler: async (ctx, args) => {
      const posts = await deps.social.listPosts(ctx.workspaceId);
      const status = typeof args.status === 'string' ? args.status : 'SCHEDULED';
      return posts.filter((p: { status: string }) => p.status === status);
    },
  });

  registry.register({
    name: 'jeeta.draft_social_post',
    description:
      'Create a DRAFT social post (content + optional media/target accounts). This has no external side effect — nothing is posted until jeeta.publish_social_post (or the scheduler) runs it. Ungated (no approval), but still requires write authority.',
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      content: z.string().min(1).describe('Post copy/caption text.'),
      mediaUrls: z
        .array(z.string())
        .optional()
        .describe('Public media URLs to attach (images/video).'),
      targetAccountIds: z
        .array(z.string())
        .optional()
        .describe('Connected social account ids to target when this post is scheduled or published.'),
    }),
    handler: async (ctx, args) =>
      deps.social.createPost(ctx.workspaceId, {
        content: String(args.content ?? ''),
        mediaUrls: Array.isArray(args.mediaUrls) ? args.mediaUrls.map(String) : undefined,
        targetAccountIds: Array.isArray(args.targetAccountIds)
          ? args.targetAccountIds.map(String)
          : undefined,
      }),
  });

  registry.register({
    name: 'jeeta.publish_social_post',
    description:
      'Publish a draft or scheduled social post immediately, to every attached target account. This reaches a real audience, so in APPROVAL mode it is queued for a human instead of publishing immediately.',
    scopes: ['campaigns.send'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'PUBLISH',
    inputSchema: z.object({
      postId: z.string().min(1).describe('Social post id (draft or scheduled) to publish now.'),
    }),
    handler: async (ctx, args) => deps.social.publishNow(ctx.workspaceId, String(args.postId ?? '')),
  });
}
