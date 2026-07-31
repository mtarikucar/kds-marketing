import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { CampaignsService } from '../../campaigns/campaigns.service';
import { MarketingLeadsService } from '../../services/marketing-leads.service';
import { SalesCallService } from '../../services/sales-call.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService, visibilityPrincipal } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { audienceFilterSchema } from './campaigns-write.tools';

export interface VoiceToolDeps {
  calls: SalesCallService;
  leads: MarketingLeadsService;
  campaigns: CampaignsService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

const CALL_STATUSES = ['INITIATED', 'CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED'] as const;

/**
 * Faz 5 D3 — telephony and voice.
 *
 * ## `jeeta.click_to_dial` and consent
 *
 * `SalesCallService.startCall` has NO opt-out check, and that is correct for
 * the surface it was written for: a rep clicking "call" on a lead they are
 * looking at is a human deciding to ring a person. An agent placing that same
 * call unattended is a different act, and the same absence becomes the exact
 * legal problem the campaign lane goes to such lengths to avoid.
 *
 * So this tool does not hand `startCall` a free-text phone number. It takes a
 * `leadId`, reads the lead, and refuses if that lead is not reachable by
 * phone — applying the SAME predicate the product already uses to decide
 * voice reachability, rather than inventing an MCP-specific rule:
 *
 *  - `smsOptOut` is the documented voice opt-out proxy. `buildAudienceWhere`'s
 *    VOICE branch and `CampaignSenderService.isOptedOut` both read exactly this
 *    column for voice campaigns (the Lead model has no separate call/voice
 *    opt-out column yet), each with the same note.
 *  - soft-deleted (`deletedAt`) and merged (`mergedIntoId`) leads are excluded,
 *    matching `buildAudienceWhere`'s tombstone guard — a merged lead's number
 *    belongs to the surviving record.
 *  - the number dialled is the one stored on the lead, so an agent cannot
 *    smuggle in an arbitrary destination and cannot dial a lead who has none.
 *
 * This is not a reimplementation of consent logic; it is the existing
 * predicate applied before a service that does not apply it. The İYS registry
 * is deliberately NOT consulted here: İYS `ARAMA` consent governs bulk
 * commercial calling (`CampaignSenderService.iysArmaPreflight`, on VOICE
 * campaigns), which is what `jeeta.create_voice_campaign` feeds — a single
 * 1:1 call placed in the course of an existing sales conversation is the same
 * act a rep performs from the panel today.
 *
 * ## Why no arming verb for voice campaigns
 * `jeeta.create_voice_campaign` writes a DRAFT and nothing else — same
 * reasoning as D2's `create_social_campaign`. Launching it (which dials an
 * entire audience, spends telephony minutes and triggers the İYS `ARAMA`
 * preflight) stays with `jeeta.set_campaign_status`, which is approval-gated.
 */
export function registerVoiceTools(registry: McpToolRegistry, deps: VoiceToolDeps): void {
  registry.register({
    name: 'jeeta.click_to_dial',
    description:
      'Place an outbound phone call to a lead using their stored number. This rings a real person, so in APPROVAL mode it is queued for a human instead of dialling immediately. Leads who have opted out of phone contact, have no number, or have been deleted or merged are refused.',
    domain: 'voice',
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'SEND',
    resourceType: 'lead',
    resourceIdFrom: (args) => (typeof args.leadId === 'string' ? args.leadId : undefined),
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Lead to call. The number is taken from the lead record.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'telephony');
      const leadId = String(args.leadId ?? '');
      // Resolve the principal FIRST: the call is attributed to (and its line
      // reserved against) a real MarketingUser, and on an API-key session that
      // is the workspace's automation principal.
      const actor = await deps.principals.resolve(ctx);
      const who = visibilityPrincipal(ctx);
      const lead = (await deps.leads.findOne(ctx.workspaceId, leadId, who.userId, who.role)) as {
        phone?: string | null;
        smsOptOut?: boolean | null;
        deletedAt?: Date | null;
        mergedIntoId?: string | null;
      };

      if (lead.deletedAt || lead.mergedIntoId) {
        throw new BadRequestException(`lead ${leadId} has been deleted or merged and must not be called`);
      }
      if (lead.smsOptOut) {
        throw new BadRequestException(
          `lead ${leadId} has opted out of phone contact and must not be called. Record consent in the panel first if that is wrong.`,
        );
      }
      const phone = typeof lead.phone === 'string' ? lead.phone.trim() : '';
      if (!phone) throw new BadRequestException(`lead ${leadId} has no phone number on record`);

      return deps.calls.startCall(ctx.workspaceId, actor.id, { toPhone: phone, leadId });
    },
  });

  registry.register({
    name: 'jeeta.list_calls',
    description:
      'List sales calls in this workspace (direction, number, status, duration, cost and recording availability), newest first. Read-only.',
    domain: 'voice',
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().optional().describe('Restrict results to calls linked to this lead.'),
      status: z.enum(CALL_STATUSES).optional().describe('Restrict results to one call status.'),
      marketingUserId: z
        .string()
        .optional()
        .describe('Restrict results to one rep. Ignored for a REP-scoped caller, who only ever sees their own calls.'),
      page: z.number().int().min(1).optional().describe('1-based page number (default 1).'),
      limit: z.number().int().min(1).max(200).optional().describe('Results per page (default 20, capped at 200).'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'telephony');
      // `SalesCallService.list` narrows to the caller's own calls when their
      // role is REP — pass the SAME visibility principal the other read tools
      // use so an OAuth session inherits the human's real row-level access and
      // an API-key session keeps the declared "not REP" placeholder.
      const who = visibilityPrincipal(ctx);
      return deps.calls.list(
        ctx.workspaceId,
        {
          ...(typeof args.leadId === 'string' ? { leadId: args.leadId } : {}),
          ...(typeof args.status === 'string' ? { status: args.status as never } : {}),
          ...(typeof args.marketingUserId === 'string' ? { marketingUserId: args.marketingUserId } : {}),
          ...(typeof args.page === 'number' ? { page: args.page } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        },
        { id: who.userId, role: who.role } as never,
      );
    },
  });

  registry.register({
    name: 'jeeta.create_voice_campaign',
    description:
      'Create an automated voice (robocall) campaign as a DRAFT: a spoken message or an uploaded audio file, the audience rules and optional press-a-key options. Nothing is dialled until the campaign is launched with jeeta.set_campaign_status(status="SENDING"), which needs human approval. Opted-out and unreachable leads are excluded automatically, and commercial (TICARI) campaigns are additionally checked against the Turkish İYS consent registry before any number is dialled.',
    domain: 'voice',
    // Deferred (spec §3): a large one-off setup call, not a per-turn action.
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('Campaign name, for the panel.'),
      body: z
        .string()
        .min(1)
        .max(20000)
        .describe('Human-readable description of the call, shown in the panel. The spoken content comes from voiceConfig.'),
      voiceConfig: z
        .object({
          msg: z.string().max(2000).optional().describe('Text to read out (text-to-speech). Required unless audioid is given.'),
          audioid: z.string().max(64).optional().describe('Id of an uploaded audio file to play instead of TTS.'),
          keys: z
            .array(z.string().max(4))
            .max(10)
            .optional()
            .describe('DTMF digits the callee may press, e.g. ["1","2"].'),
        })
        .describe('What the call plays. Exactly one of msg or audioid is required.'),
      audienceFilter: audienceFilterSchema,
      scheduledAt: z.string().optional().describe('ISO 8601 time to dial at. Only takes effect once the campaign is launched.'),
      iysMessageType: z
        .enum(['TICARI', 'BILGILENDIRME'])
        .optional()
        .describe(
          'Turkish İYS classification. TICARI = commercial, and every number is checked against the İYS ARAMA consent registry before dialling. BILGILENDIRME = informational/transactional.',
        ),
    }),
    handler: async (ctx, args) => {
      // Gated on `voiceCampaigns` here and AGAIN inside CampaignsService.create
      // for the VOICE branch. The duplicate is intentional: this one produces
      // the agent-readable refusal before any work starts, the service one is
      // the guard every caller (REST included) passes through.
      await assertFeature(deps.entitlements, ctx.workspaceId, 'voiceCampaigns');
      return deps.campaigns.create(ctx.workspaceId, {
        name: String(args.name ?? ''),
        channel: 'VOICE',
        body: String(args.body ?? ''),
        voiceConfig: args.voiceConfig as { msg?: string; audioid?: string; keys?: string[] },
        ...(args.audienceFilter !== undefined ? { audienceFilter: args.audienceFilter } : {}),
        ...(args.scheduledAt !== undefined ? { scheduledAt: String(args.scheduledAt) } : {}),
        ...(args.iysMessageType !== undefined ? { iysMessageType: String(args.iysMessageType) } : {}),
      });
    },
  });
}
