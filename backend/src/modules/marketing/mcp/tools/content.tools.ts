import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { MediaGenService } from '../../ai/media/media-gen.service';
import { UnifiedCalendarService } from '../../trends/unified-calendar.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ContentToolDeps {
  calendar: UnifiedCalendarService;
  media: MediaGenService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

/** Mirrors MarketingContentCalendarController's defaults and caps exactly. */
const DEFAULT_BACK_MS = 7 * 86_400_000;
const DEFAULT_FORWARD_MS = 60 * 86_400_000;
const MAX_RANGE_MS = 180 * 86_400_000;

const ASPECT_RATIOS = ['1:1', '9:16', '16:9', '4:5'] as const;
const ASSET_TYPES = ['IMAGE', 'VIDEO'] as const;
const ASSET_STATUSES = ['QUEUED', 'GENERATING', 'READY', 'FAILED', 'BLOCKED'] as const;
/** `MediaGenService` clamps to MEDIA_GEN_MAX_VIDEO_SEC (10 by default); the
 *  schema states the same ceiling so the model is told, not silently trimmed. */
const MAX_VIDEO_SEC = 10;

function parseDate(value: unknown, field: string): Date {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} must be an ISO 8601 date-time (e.g. 2026-08-05T09:30:00Z)`);
  }
  return d;
}

/**
 * Faz 5 D2 — the content-planning half of the wave: the unified calendar and
 * AI media generation.
 *
 * ## Calendar
 * `jeeta.get_content_calendar` wraps `UnifiedCalendarService.range`, the same
 * read model the panel's calendar page uses (social posts + AI social-campaign
 * items, deduped when an item has already materialized into a post). The
 * REST controller's defaults (−7d / +60d) and its guards (`to` after `from`,
 * max 180 days) are reproduced here rather than dropped: they are what keep a
 * "show me the calendar" call from returning years of rows into a context
 * window, and a model is far more likely than a UI to ask for 2020–2030.
 * `reports.read` matches the REST gate.
 *
 * ## AI media
 * `jeeta.generate_image` / `jeeta.generate_video` are the wave's only tools
 * that spend real cash: `MediaGenService.requestGeneration` reserves AI credits
 * (`media.image.generate` 3cr / `media.video.generate` 15cr floor, with the
 * per-model estimate in `media-models.config` governing the actual reserve) and,
 * for engine-owned generations under an armed autonomous budget, pre-debits the
 * growth wallet in USD.
 *
 * **None of that is reimplemented here, deliberately.** The reserve → submit →
 * poll/webhook → reconcile-or-refund lifecycle is one of the most carefully
 * balanced paths in the codebase (exactly-once refunds via conditional claims,
 * an orphan sweep for abandoned generations, estimate-vs-actual true-up on a
 * shorter clip). A tool that metered credits itself would double-charge; a tool
 * that called the provider directly would leak the reservation. So these tools
 * only translate arguments and hand off — every credit and wallet effect is
 * inherited from the single service the REST controller calls.
 *
 * Risk: `SPEND`, per design spec §4 — money that leaves the workspace is not
 * recoverable by reading the audit log later, so the broker
 * (`ALWAYS_APPROVED_RISKS`) queues these for a human in EVERY write mode,
 * AUTONOMOUS included. `approvalKind: 'MEDIA_SPEND'` rather than `AD_SPEND` so
 * the approvals queue does not label an image generation as an ad budget move.
 *
 * ## Feature gating
 * All three media tools sit behind the `mediaGen` package feature, checked with
 * `assertFeature` — the same `EntitlementsService.getEffective` read and the
 * same `FEATURE_NOT_IN_PACKAGE` 403 the REST `@RequiresFeature('mediaGen')`
 * guard on `MarketingMediaController` produces. MCP tools bypass Nest's guard
 * pipeline, so without this a workspace could reach through MCP a module its
 * package denies over REST. The check runs FIRST — before the principal is
 * resolved and long before anything is reserved — so an unentitled workspace
 * gets a sentence it can act on, not a partial side effect.
 *
 * ## Attribution
 * `GeneratedAsset.createdById` is a real FK. An API-key session has no human
 * behind it, so the actor comes from `McpPrincipalService.resolve` (the
 * workspace's SYSTEM research sentinel) rather than an invented id — see
 * `MCP_ATTRIBUTION_PRINCIPAL_ROLE`.
 */
export function registerContentTools(registry: McpToolRegistry, deps: ContentToolDeps): void {
  registry.register({
    name: 'jeeta.get_content_calendar',
    description:
      'Get the unified content calendar for a date range: every scheduled/published social post plus planned AI social-campaign items, time-ordered. Defaults to the last 7 and next 60 days; the range may not exceed 180 days. Read-only.',
    domain: 'content',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      from: z.string().optional().describe('Window start, ISO 8601. Defaults to 7 days ago.'),
      to: z.string().optional().describe('Window end, ISO 8601. Defaults to 60 days from now.'),
    }),
    handler: async (ctx, args) => {
      const now = Date.now();
      const from = args.from !== undefined ? parseDate(args.from, 'from') : new Date(now - DEFAULT_BACK_MS);
      const to = args.to !== undefined ? parseDate(args.to, 'to') : new Date(now + DEFAULT_FORWARD_MS);
      if (to <= from) throw new BadRequestException('`to` must be after `from`');
      if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
        throw new BadRequestException('range too wide (max 180 days)');
      }
      return deps.calendar.range(ctx.workspaceId, from, to);
    },
  });

  registry.register({
    name: 'jeeta.generate_image',
    description:
      'Generate an image with AI (fal.ai) for use in social content. This SPENDS the workspace\'s AI credits — in APPROVAL mode this queues for a human; in AUTONOMOUS mode it runs immediately. Returns an assetId; poll jeeta.list_generated_media until its status is READY to get the URL.',
    domain: 'content',
    scopes: ['campaigns.send'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'MEDIA_SPEND',
    inputSchema: z.object({
      prompt: z.string().min(1).max(2000).describe('What to generate.'),
      model: z
        .string()
        .max(200)
        .optional()
        .describe('Catalogued image model id (see media-models.config). Defaults to the workspace default; an uncatalogued id is refused because its price is unknown.'),
      negativePrompt: z.string().max(1000).optional().describe('What to avoid.'),
      aspectRatio: z.enum(ASPECT_RATIOS).optional().describe('Output aspect ratio.'),
      referenceImageUrls: z
        .array(z.string())
        .max(5)
        .optional()
        .describe('Up to 5 public reference image URLs to condition on.'),
      seed: z.number().int().optional().describe('Deterministic seed.'),
      // Both ids, for the same reasons the video tool carries them — an image
      // is not exempt from either. Without socialCampaignId the asset is on
      // `sweepOrphanAssets`' 30-day delete list; without campaignItemId it is
      // off the armed-budget pre-debit path. Commit 88c95d77 said "every
      // MCP-generated asset was an orphan" and then fixed only video, so every
      // image an agent generated kept being deleted at 30 days.
      socialCampaignId: z
        .string()
        .max(64)
        .optional()
        .describe(
          'The social campaign this image belongs to (see jeeta.list_social_campaigns). Say it when there is one: an asset with no campaign is DELETED after 30 days by the orphan sweep.',
        ),
      campaignItemId: z
        .string()
        .max(64)
        .optional()
        .describe(
          'The campaign item (calendar slot) this image is for (see jeeta.list_social_campaigns). Marks the generation as engine work, which an armed autonomous budget pays for out of the growth wallet.',
        ),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'mediaGen');
      const actor = await deps.principals.resolve(ctx);
      return deps.media.requestGeneration(ctx.workspaceId, {
        type: 'IMAGE',
        prompt: String(args.prompt ?? ''),
        ...(args.model !== undefined ? { model: String(args.model) } : {}),
        ...(args.negativePrompt !== undefined ? { negativePrompt: String(args.negativePrompt) } : {}),
        ...(args.aspectRatio !== undefined ? { aspectRatio: String(args.aspectRatio) } : {}),
        ...(Array.isArray(args.referenceImageUrls)
          ? { referenceImageUrls: args.referenceImageUrls.map(String) }
          : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        // Forwarded, not trusted: `MediaGenService` proves both against THIS
        // workspace before anything is reserved — the same ownership check the
        // video tool leans on, reused rather than repeated.
        ...(args.socialCampaignId !== undefined
          ? { socialCampaignId: String(args.socialCampaignId) }
          : {}),
        ...(args.campaignItemId !== undefined
          ? { campaignItemId: String(args.campaignItemId) }
          : {}),
        createdById: actor.id,
      });
    },
  });

  registry.register({
    name: 'jeeta.generate_video',
    description:
      `Generate a short video with AI (fal.ai) for use in social content, up to ${MAX_VIDEO_SEC} seconds. This SPENDS the workspace's AI credits (video is the most expensive action in the product) — in APPROVAL mode this queues for a human; in AUTONOMOUS mode it runs immediately. Returns an assetId; poll jeeta.list_generated_media until its status is READY.`,
    domain: 'content',
    // Deferred (spec §3): Expensive and rare next to jeeta.generate_image.
    defer: true,
    scopes: ['campaigns.send'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'MEDIA_SPEND',
    inputSchema: z.object({
      prompt: z.string().min(1).max(2000).describe('What to generate.'),
      model: z
        .string()
        .max(200)
        .optional()
        .describe('Catalogued video model id (see media-models.config). Defaults to the workspace default; an uncatalogued id is refused because its price is unknown.'),
      negativePrompt: z.string().max(1000).optional().describe('What to avoid.'),
      aspectRatio: z.enum(ASPECT_RATIOS).optional().describe('Output aspect ratio.'),
      durationSec: z
        .number()
        .int()
        .min(1)
        .max(MAX_VIDEO_SEC)
        .optional()
        .describe(`Clip length in seconds (1-${MAX_VIDEO_SEC}). Longer clips cost proportionally more credits.`),
      referenceImageUrls: z
        .array(z.string())
        .max(5)
        .optional()
        .describe('Up to 5 public reference image URLs to condition on.'),
      seed: z.number().int().optional().describe('Deterministic seed.'),
      socialCampaignId: z
        .string()
        .max(64)
        .optional()
        .describe(
          'The social campaign this clip belongs to (see jeeta.list_social_campaigns). Say it when there is one: an asset with no campaign is DELETED after 30 days by the orphan sweep.',
        ),
      campaignItemId: z
        .string()
        .max(64)
        .optional()
        .describe(
          'The campaign item (calendar slot) this clip is for. Marks the generation as engine work, which an armed autonomous budget pays for out of the growth wallet.',
        ),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'mediaGen');
      const actor = await deps.principals.resolve(ctx);
      return deps.media.requestGeneration(ctx.workspaceId, {
        type: 'VIDEO',
        prompt: String(args.prompt ?? ''),
        ...(args.model !== undefined ? { model: String(args.model) } : {}),
        ...(args.negativePrompt !== undefined ? { negativePrompt: String(args.negativePrompt) } : {}),
        ...(args.aspectRatio !== undefined ? { aspectRatio: String(args.aspectRatio) } : {}),
        ...(typeof args.durationSec === 'number' ? { durationSec: args.durationSec } : {}),
        ...(Array.isArray(args.referenceImageUrls)
          ? { referenceImageUrls: args.referenceImageUrls.map(String) }
          : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        // Both forwarded, both PROVEN by MediaGenService against this workspace
        // before anything is reserved — a model can name any id it likes, and
        // socialCampaignId is a real FK.
        ...(args.socialCampaignId !== undefined
          ? { socialCampaignId: String(args.socialCampaignId) }
          : {}),
        ...(args.campaignItemId !== undefined
          ? { campaignItemId: String(args.campaignItemId) }
          : {}),
        createdById: actor.id,
      });
    },
  });

  registry.register({
    name: 'jeeta.list_generated_media',
    description:
      'List AI-generated images/videos in this workspace, newest first, with their status and (once READY) their public URL. Use it to poll a generation started with jeeta.generate_image/jeeta.generate_video, then pass the URL to jeeta.draft_social_post. Read-only.',
    domain: 'content',
    // Deferred (spec §3): Asset-library browse; jeeta.generate_image is the primary media entry point.
    defer: true,
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      type: z.enum(ASSET_TYPES).optional().describe('Restrict to images or videos.'),
      status: z
        .enum(ASSET_STATUSES)
        .optional()
        .describe('Restrict to one generation status. READY assets are the ones with a usable URL.'),
      socialCampaignId: z
        .string()
        .max(64)
        .optional()
        .describe('Only assets belonging to this social campaign.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'mediaGen');
      return deps.media.listAssets(ctx.workspaceId, {
        ...(args.type !== undefined ? { type: String(args.type) } : {}),
        ...(args.status !== undefined ? { status: String(args.status) } : {}),
        ...(args.socialCampaignId !== undefined
          ? { socialCampaignId: String(args.socialCampaignId) }
          : {}),
      });
    },
  });
}
