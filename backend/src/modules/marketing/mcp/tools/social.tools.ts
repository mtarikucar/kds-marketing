import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { SocialPlannerService } from '../../social-planner/social-planner.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface SocialToolDeps {
  social: SocialPlannerService;
}

const POST_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED'] as const;
/** `ANY` is a tool-level sentinel, not a stored status — see the list tool. */
const POST_STATUS_FILTERS = [...POST_STATUSES, 'ANY'] as const;
const POST_FORMATS = ['FEED', 'REEL', 'STORY'] as const;

/** Hard ceiling on rows returned to a model in one call. `listPosts` is an
 *  unbounded `findMany`; a workspace with thousands of drafts would otherwise
 *  return them all into a context window (and into the ToolCallLog result
 *  column). Newest-first ordering comes from the service, so the cap keeps the
 *  most recent — the ones a planning agent actually wants. */
const MAX_POSTS = 100;

/** Parse an ISO date argument, refusing anything the Date constructor would
 *  silently turn into `Invalid Date` (which Prisma then rejects with an opaque
 *  error) or, worse, into the epoch. Model-supplied dates are exactly where
 *  "next tuesday" shows up. */
function parseDate(value: unknown, field: string): Date {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} must be an ISO 8601 date-time (e.g. 2026-08-05T09:30:00Z)`);
  }
  return d;
}

function optionalDate(value: unknown, field: string): Date | undefined {
  return value === undefined || value === null ? undefined : parseDate(value, field);
}

/**
 * A connected social account, projected to what an agent needs to plan and
 * target content — and nothing else.
 *
 * `SocialPlannerService.listAccounts` already masks `accessToken`/
 * `refreshToken`, but a masked secret is still secret-SHAPED material that
 * would land in the model's context and in `ToolCallLog.result`. An explicit
 * allow-list (rather than a spread-and-delete) also means a future sealed
 * column cannot leak through this tool by default.
 *
 * `needsReconnect` folds the three ways an account is present but unusable —
 * disabled, an expired token, or a refresh that failed (`lastError`, e.g.
 * `reauth_required`) — into one boolean, so an agent asked to schedule a post
 * can tell the user "reconnect Instagram in the panel first" instead of
 * scheduling onto a dead target and finding out at publish time.
 */
function projectAccount(row: Record<string, unknown>): Record<string, unknown> {
  const expiresAt = row.tokenExpiresAt as Date | string | null | undefined;
  const expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
  return {
    id: row.id,
    network: row.network,
    externalId: row.externalId,
    displayName: row.displayName,
    accountType: row.accountType ?? null,
    connectedVia: row.connectedVia ?? null,
    enabled: row.enabled === true,
    tokenExpiresAt: expiresAt ?? null,
    lastError: row.lastError ?? null,
    needsReconnect: row.enabled !== true || expired || Boolean(row.lastError),
    createdAt: row.createdAt ?? null,
  };
}

/**
 * Social planner tools.
 *
 * ## Faz 1-2 (the original three)
 * `SocialPlannerService.listPosts` is a flat, unfiltered list — it has no
 * server-side status filter — so `jeeta.list_scheduled_posts` filters the
 * result client-side, defaulting to SCHEDULED (matching the tool's name) with
 * an optional override so a caller can still ask for drafts/published/failed.
 * `jeeta.draft_social_post` creates a DRAFT row with no external side effect,
 * so it is deliberately ungated (no approval), but it is still a write: the
 * REST equivalent (`SocialPlannerController.createPost`) is gated
 * `@RequirePermission('campaigns.send')`, so the MCP tool mirrors that rather
 * than the weaker `campaigns.read` — a read-only key must not be able to create
 * rows. `jeeta.publish_social_post` calls `publishNow`, which reaches a real
 * audience, so it is registered `requiresApproval: true` /
 * `approvalKind: 'PUBLISH'` — the broker enqueues a human approval instead of
 * running the handler inline unless the workspace's writeMode is AUTONOMOUS.
 *
 * `jeeta.draft_social_post` is scoped `campaigns.write`, not `campaigns.send`:
 * a caller that may only prepare content should not be forced to also carry
 * the authority that publishes it to a real audience. This is narrower than
 * the REST equivalent (`SocialPlannerController.createPost`), which is still
 * gated `@RequirePermission('campaigns.send')` — that REST gate is untouched
 * here; only the MCP tool's own scope requirement moved to the new granular
 * `campaigns.write` permission (see `roles/permissions.ts`).
 *
 * ## Faz 5 D2 — the rest of the content loop
 * The owner's goal is "connect the accounts in the panel, then run all content
 * work from Claude", which needs the whole post lifecycle, not just draft and
 * publish-now. Added here: `list_social_accounts` (what can I even target?),
 * `get_social_post`, `update_social_post`, `schedule_social_post` and
 * `delete_social_post`.
 *
 * Risk classification follows design spec §4 and is the load-bearing part:
 *
 * - `schedule_social_post` is **PUBLISH-gated, not WRITE**. It reaches a real
 *   audience with no further human touch; the only difference from
 *   `publish_social_post` is a timer. Ranking it WRITE because "nothing
 *   happens right now" would make the delay itself the loophole — an agent
 *   could schedule the same content for 60 seconds out and skip the gate.
 * - `delete_social_post` is the new **DESTRUCTIVE** class: `deletePost` is a
 *   hard `prisma.socialPost.delete` with no soft-delete column and no undo, and
 *   it cascades the post's targets. Per §4 that queues for a human in EVERY
 *   write mode, AUTONOMOUS included (`McpBrokerService.ALWAYS_APPROVED_RISKS`).
 * - `update_social_post` stays an ungated WRITE: `SocialPlannerService`
 *   refuses to edit anything but a DRAFT (`assertDraftPost`), so it cannot
 *   rewrite content that is already scheduled or live.
 *
 * Scope choices mirror the draft/publish split above: reading and editing
 * DRAFT content needs `campaigns.write`; putting content in front of an
 * audience needs `campaigns.send`. `delete_social_post` sits on
 * `campaigns.write` — deleting a draft is content management, not audience
 * reach — and is protected by the mandatory approval rather than by demanding
 * the publish authority.
 */
export function registerSocialTools(registry: McpToolRegistry, deps: SocialToolDeps): void {
  registry.register({
    name: 'jeeta.list_social_accounts',
    description:
      'List the social accounts connected to this workspace (network, handle/display name, account type, and whether the connection is healthy). Use this first to discover the account ids to target when drafting or scheduling a post. Never returns tokens. Read-only.',
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      network: z
        .string()
        .max(32)
        .optional()
        .describe('Restrict to one network, e.g. INSTAGRAM, FACEBOOK, LINKEDIN, TIKTOK, TWITTER.'),
    }),
    handler: async (ctx, args) => {
      const rows = (await deps.social.listAccounts(ctx.workspaceId)) as Array<Record<string, unknown>>;
      const network = typeof args.network === 'string' ? args.network.toUpperCase() : undefined;
      return rows
        .filter((r) => !network || String(r.network).toUpperCase() === network)
        .map(projectAccount);
    },
  });

  registry.register({
    name: 'jeeta.list_scheduled_posts',
    description:
      'List social posts in this workspace, newest first. Defaults to SCHEDULED (upcoming) posts; pass status to see drafts, publishing, published or failed posts, or status="ANY" for all of them. Optional from/to narrow to a scheduled-time window. Read-only.',
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z
        .enum(POST_STATUS_FILTERS)
        .optional()
        .describe('Restrict to posts in this status, or "ANY" for every status. Defaults to SCHEDULED.'),
      from: z
        .string()
        .optional()
        .describe('Only posts scheduled at or after this ISO 8601 instant. Posts with no scheduled time are excluded when a window is given.'),
      to: z
        .string()
        .optional()
        .describe('Only posts scheduled at or before this ISO 8601 instant.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_POSTS)
        .optional()
        .describe(`Maximum posts to return (default and hard cap ${MAX_POSTS}).`),
    }),
    handler: async (ctx, args) => {
      // Parse the window BEFORE the query so a bad date is a clear refusal
      // rather than a silently-empty list the model reads as "no posts".
      const from = optionalDate(args.from, 'from');
      const to = optionalDate(args.to, 'to');
      const posts = (await deps.social.listPosts(ctx.workspaceId)) as Array<{
        status: string;
        scheduledAt?: Date | string | null;
      }>;
      const status = typeof args.status === 'string' ? args.status : 'SCHEDULED';
      const limit = typeof args.limit === 'number' ? Math.min(args.limit, MAX_POSTS) : MAX_POSTS;
      return posts
        .filter((p) => (status === 'ANY' ? true : p.status === status))
        .filter((p) => {
          if (!from && !to) return true;
          if (!p.scheduledAt) return false;
          const at = new Date(p.scheduledAt).getTime();
          if (from && at < from.getTime()) return false;
          if (to && at > to.getTime()) return false;
          return true;
        })
        .slice(0, limit);
    },
  });

  registry.register({
    name: 'jeeta.get_social_post',
    description:
      'Get one social post with its content, media, status and per-account publish targets. Read-only.',
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      postId: z.string().min(1).describe('Social post id.'),
    }),
    handler: async (ctx, args) => deps.social.getPost(ctx.workspaceId, String(args.postId ?? '')),
  });

  registry.register({
    name: 'jeeta.draft_social_post',
    description:
      'Create a DRAFT social post (content + optional media/target accounts). This has no external side effect — nothing is posted until jeeta.schedule_social_post or jeeta.publish_social_post runs it. Ungated (no approval), but still requires write authority.',
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
    name: 'jeeta.update_social_post',
    description:
      'Edit a DRAFT social post: its copy, media or target accounts. Only DRAFT posts can be edited — a scheduled or published post is refused. Fields you omit are left untouched. Ungated (no approval).',
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      postId: z.string().min(1).describe('Social post id (must still be a DRAFT).'),
      content: z.string().min(1).optional().describe('Replacement copy/caption text.'),
      mediaUrls: z
        .array(z.string())
        .optional()
        .describe('Replacement list of public media URLs. Pass [] to remove all media.'),
      targetAccountIds: z
        .array(z.string())
        .optional()
        .describe('Replacement target account ids (replaces the post\'s pending targets).'),
    }),
    handler: async (ctx, args) =>
      deps.social.updatePost(ctx.workspaceId, String(args.postId ?? ''), {
        // Only forward what the caller actually named: `updatePost` treats
        // `undefined` as "leave alone", so spreading absent keys as null/[]
        // would silently wipe a field the agent never mentioned.
        ...(args.content !== undefined ? { content: String(args.content) } : {}),
        ...(Array.isArray(args.mediaUrls) ? { mediaUrls: args.mediaUrls.map(String) } : {}),
        ...(Array.isArray(args.targetAccountIds)
          ? { targetAccountIds: args.targetAccountIds.map(String) }
          : {}),
      }),
  });

  registry.register({
    name: 'jeeta.schedule_social_post',
    description:
      'Schedule a draft post to publish automatically at a future time, to every attached target account. This reaches a real audience with no further human step, so it is queued for approval exactly like publishing now.',
    scopes: ['campaigns.send'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'PUBLISH',
    // Dedupe key: see McpBrokerService.invoke()'s supersede sweep. A re-ask
    // ("no, make it Thursday") must replace the pending card, not add a second.
    resourceType: 'social_post',
    resourceIdFrom: (args) => (typeof args.postId === 'string' ? args.postId : undefined),
    inputSchema: z.object({
      postId: z.string().min(1).describe('Social post id (DRAFT or already SCHEDULED — rescheduling is allowed).'),
      scheduledAt: z
        .string()
        .min(1)
        .describe('When to publish, ISO 8601 (e.g. 2026-08-05T09:30:00Z). Interpreted as an absolute instant.'),
      targetAccountIds: z
        .array(z.string())
        .optional()
        .describe('Accounts to publish to. Replaces the post\'s pending targets when given; the post must end up with at least one.'),
      formats: z
        .record(z.string(), z.enum(POST_FORMATS))
        .optional()
        .describe('Per-account publish format, keyed by social account id, e.g. {"acc1":"REEL"}. Defaults to FEED.'),
    }),
    handler: async (ctx, args) =>
      deps.social.schedulePost(
        ctx.workspaceId,
        String(args.postId ?? ''),
        parseDate(args.scheduledAt, 'scheduledAt'),
        Array.isArray(args.targetAccountIds) ? args.targetAccountIds.map(String) : undefined,
        (args.formats as Record<string, string> | undefined) ?? undefined,
      ),
  });

  registry.register({
    name: 'jeeta.publish_social_post',
    description:
      'Publish a draft or scheduled social post immediately, to every attached target account. This reaches a real audience, so in APPROVAL mode it is queued for a human instead of publishing immediately.',
    scopes: ['campaigns.send'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'PUBLISH',
    // Dedupe key: see McpBrokerService.invoke()'s supersede sweep.
    resourceType: 'social_post',
    resourceIdFrom: (args) => (typeof args.postId === 'string' ? args.postId : undefined),
    inputSchema: z.object({
      postId: z.string().min(1).describe('Social post id (draft or scheduled) to publish now.'),
    }),
    handler: async (ctx, args) => deps.social.publishNow(ctx.workspaceId, String(args.postId ?? '')),
  });

  registry.register({
    name: 'jeeta.delete_social_post',
    description:
      'Permanently delete a social post and its publish targets. There is no undo and no trash — this always requires a human approval, in every write mode, including autonomous.',
    scopes: ['campaigns.write'],
    risk: 'DESTRUCTIVE',
    requiresApproval: true,
    approvalKind: 'DESTRUCTIVE',
    resourceType: 'social_post',
    resourceIdFrom: (args) => (typeof args.postId === 'string' ? args.postId : undefined),
    inputSchema: z.object({
      postId: z.string().min(1).describe('Social post id to delete permanently.'),
    }),
    handler: async (ctx, args) => deps.social.deletePost(ctx.workspaceId, String(args.postId ?? '')),
  });
}
