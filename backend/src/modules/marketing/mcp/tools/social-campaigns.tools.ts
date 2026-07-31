import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { SocialCampaignsService } from '../../social-campaigns/social-campaigns.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface SocialCampaignToolDeps {
  socialCampaigns: SocialCampaignsService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

const AUTOMATION_MODES = ['APPROVAL', 'SEMI_AUTO', 'FULL_AUTO'] as const;
const PLANNING_MODES = ['AI_PROPOSE', 'AI_FULL', 'USER_TOPICS'] as const;
const MEDIA_KINDS = ['IMAGE', 'VIDEO'] as const;

function parseDate(value: unknown, field: string): Date {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} must be an ISO 8601 date (e.g. 2026-08-01)`);
  }
  return d;
}

/**
 * Faz 5 D2 — social campaigns (the AI content ENGINE), read + create.
 *
 * ## Is `socialCampaigns` real or vestigial? Real.
 * It is a plan-entitled package feature (`false` on the two entry blocks,
 * `true` on the three upper ones in `prisma/seed-packages.ts`), it has a
 * running engine — `SocialCampaignsService` registers three scheduled-job
 * handlers (plan tick → item generate → confirm/publish) and drives
 * `MediaGenService` + `SocialPlannerService` — and it has a live panel surface
 * (`/social-campaigns/:id`, the campaign list under Studio, an approval queue
 * and a calendar). Not a dead flag.
 *
 * ## Why create, but not activate
 * `create()` writes a `DRAFT` row and schedules nothing; `activate()` is what
 * arms the planner and starts the cadence that generates media (spending
 * credits) and publishes to a real audience unattended. Exposing create alone
 * lets an agent do the useful, reversible part — draft the whole campaign
 * (brief, cadence, targets, media kinds) from a conversation — and leaves the
 * irreversible part, switching an autonomous publishing machine ON, as a
 * deliberate human act in the panel where the automation mode and its
 * consequences are visible. This is not a scope oversight; adding
 * `activate_social_campaign` later is a decision about autonomy, not a missing
 * CRUD verb. Consequently the create tool is a plain `WRITE` — an inert draft
 * row — rather than PUBLISH or SPEND.
 *
 * Both tools sit behind the `socialCampaigns` package feature via
 * `assertFeature`, matching `@RequiresFeature('socialCampaigns')` on
 * `SocialCampaignsController`, and `SocialCampaign.createdById` is filled from
 * `McpPrincipalService.resolve` (a real FK — never a fabricated id).
 */
export function registerSocialCampaignTools(
  registry: McpToolRegistry,
  deps: SocialCampaignToolDeps,
): void {
  registry.register({
    name: 'jeeta.list_social_campaigns',
    description:
      'List the AI social campaigns in this workspace (name, goal, automation/planning mode, cadence, status and pipeline stats), newest first. Read-only.',
    domain: 'social',
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      return deps.socialCampaigns.list(ctx.workspaceId);
    },
  });

  registry.register({
    name: 'jeeta.create_social_campaign',
    description:
      'Create an AI social campaign as a DRAFT: a brief, a publishing cadence, the accounts to post to and which media kinds to generate. Nothing is planned, generated or published until someone activates the campaign in the panel — activation is deliberately not available to agents.',
    domain: 'social',
    // Deferred (spec §3): A large one-off setup call, not a per-turn action.
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(200).describe('Campaign name.'),
      goal: z.string().max(500).optional().describe('What the campaign should achieve.'),
      theme: z.string().max(500).optional().describe('Creative theme / angle.'),
      brief: z
        .record(z.string(), z.unknown())
        .describe('Structured brief the planner reasons over (audience, tone, offers, must-say/must-avoid...).'),
      automationMode: z
        .enum(AUTOMATION_MODES)
        .describe('APPROVAL = every item needs sign-off; SEMI_AUTO = publishes unless rejected; FULL_AUTO = publishes unattended.'),
      planningMode: z
        .enum(PLANNING_MODES)
        .describe('AI_PROPOSE = AI suggests topics for review; AI_FULL = AI plans everything; USER_TOPICS = you supply the topics.'),
      cadence: z
        .object({
          perWeek: z.number().int().min(1).optional().describe('Target posts per week.'),
          daysOfWeek: z
            .array(z.number().int().min(0).max(6))
            .min(1)
            .max(7)
            .describe('Publishing weekdays, 0 = Sunday … 6 = Saturday.'),
          timeOfDay: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'timeOfDay must be HH:MM (24-hour)')
            .describe('Publish time as HH:MM, interpreted in UTC.'),
          timezone: z.string().max(64).optional().describe('IANA timezone, stored for display.'),
        })
        .describe('When the campaign publishes.'),
      startDate: z.string().min(1).describe('First day the campaign may publish, ISO 8601.'),
      endDate: z.string().optional().describe('Last day the campaign may publish, ISO 8601. Omit for open-ended.'),
      targetAccountIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Connected social account ids to publish to (see jeeta.list_social_accounts).'),
      mediaKinds: z
        .array(z.enum(MEDIA_KINDS))
        .min(1)
        .max(2)
        .describe('Which media the campaign may generate. VIDEO costs substantially more credits than IMAGE.'),
      defaultImageModel: z.string().max(200).optional().describe('Catalogued image model id to use by default.'),
      defaultVideoModel: z.string().max(200).optional().describe('Catalogued video model id to use by default.'),
      dailyPublishCap: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum posts this campaign may publish in one day (defaults to 2).'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      // Parse dates before resolving the principal so a bad date is a plain
      // refusal rather than a half-done call.
      const startDate = parseDate(args.startDate, 'startDate');
      const endDate = args.endDate !== undefined ? parseDate(args.endDate, 'endDate') : undefined;
      const actor = await deps.principals.resolve(ctx);
      return deps.socialCampaigns.create(ctx.workspaceId, {
        name: String(args.name ?? ''),
        ...(args.goal !== undefined ? { goal: String(args.goal) } : {}),
        ...(args.theme !== undefined ? { theme: String(args.theme) } : {}),
        brief: args.brief as Record<string, unknown>,
        automationMode: args.automationMode as (typeof AUTOMATION_MODES)[number],
        planningMode: args.planningMode as (typeof PLANNING_MODES)[number],
        cadence: args.cadence as never,
        startDate,
        ...(endDate ? { endDate } : {}),
        targetAccountIds: (args.targetAccountIds as string[]).map(String),
        mediaKinds: (args.mediaKinds as string[]).map(String),
        ...(args.defaultImageModel !== undefined
          ? { defaultImageModel: String(args.defaultImageModel) }
          : {}),
        ...(args.defaultVideoModel !== undefined
          ? { defaultVideoModel: String(args.defaultVideoModel) }
          : {}),
        ...(typeof args.dailyPublishCap === 'number'
          ? { dailyPublishCap: args.dailyPublishCap }
          : {}),
        createdById: actor.id,
      });
    },
  });
}
