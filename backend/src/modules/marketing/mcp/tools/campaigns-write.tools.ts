import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { CampaignsService } from '../../campaigns/campaigns.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface CampaignWriteToolDeps {
  campaigns: CampaignsService;
  entitlements: EntitlementsService;
}

/**
 * The audience filter fields `CampaignsService.buildAudienceWhere` actually
 * honours (`LEAD_FILTER_FIELDS`, campaigns.service.ts).
 *
 * Declared as an ENUM rather than a free string on purpose. The service DROPS
 * an unrecognised field silently (`if (!LEAD_FILTER_FIELDS.has(field))
 * continue;`) — so `{field: 'tag', op: 'eq', value: 'vip'}` would not narrow
 * the audience at all, it would produce a campaign aimed at EVERY opted-in
 * lead in the workspace while reading, to the model and the user, as a
 * carefully targeted one. On a model-facing surface that failure mode is not
 * acceptable; the enum turns it into a schema error the caller can correct.
 */
const AUDIENCE_FIELDS = ['status', 'city', 'region', 'businessType', 'priority', 'source', 'businessName'] as const;
const AUDIENCE_OPS = ['eq', 'neq', 'in', 'contains', 'gte', 'lte', 'exists'] as const;

export const audienceFilterSchema = z
  .array(
    z.object({
      field: z.enum(AUDIENCE_FIELDS).describe('Lead field to filter on.'),
      op: z.enum(AUDIENCE_OPS).describe('Comparison. Use "in" with an array value; "exists" with a boolean.'),
      value: z
        .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
        .optional()
        .describe('Value to compare against. An array is only valid with "in".'),
    }),
  )
  .max(20)
  .optional()
  .describe(
    'Audience narrowing rules, ANDed together. Opt-out, deliverability and soft-delete filtering is ALWAYS applied on top and cannot be switched off. Omit to target every reachable, opted-in lead.',
  );

/**
 * Faz 5 D3 — campaign authoring (draft only).
 *
 * ## Why create but not send
 * `CampaignsService.create()` writes a `DRAFT` row and schedules nothing —
 * `launch()` is what freezes the audience and starts real delivery. Splitting
 * them keeps the reversible half (composing a campaign from a conversation)
 * available to an agent while the irreversible half stays a deliberate,
 * approval-gated act. That is not a gap: `jeeta.set_campaign_status` with
 * `status: 'SENDING'` IS the send verb — it dispatches to
 * `CampaignsService.launch()` for a DRAFT/SCHEDULED campaign and `resume()`
 * for a paused one, and it is already registered `requiresApproval: true` /
 * `approvalKind: 'PUBLISH'`. A separate `jeeta.send_campaign` would be a second
 * name for the same guarded transition and a second approval card for the same
 * action, so it is deliberately NOT registered.
 *
 * ## Compliance
 * Nothing here sends, so nothing here needs a consent check — but everything
 * this creates inherits one. Delivery only ever happens through
 * `CampaignSenderService`, which re-checks each recipient's channel opt-out at
 * send time (`isOptedOut`), runs the İYS TİCARİ preflight for SMS/VOICE, and
 * refuses to send at all without an unsubscribe link. The audience frozen by
 * `launch()` is itself built by `buildAudienceWhere`, which pins
 * `emailOptOut/smsOptOut/waOptOut: false` plus reachability and excludes
 * soft-deleted and merged leads. A campaign drafted here cannot reach an
 * opted-out lead by any path.
 *
 * VOICE is deliberately absent from this tool's channel enum — it has its own
 * entitlement, its own `voiceConfig` shape and its own İYS type (`ARAMA`, not
 * `MESAJ`), so it gets its own tool in `voice.tools.ts`.
 */
export function registerCampaignWriteTools(registry: McpToolRegistry, deps: CampaignWriteToolDeps): void {
  registry.register({
    name: 'jeeta.create_campaign',
    description:
      'Create an email, SMS or WhatsApp campaign as a DRAFT: the message, the audience rules and an optional send time. Nothing is sent until the campaign is launched with jeeta.set_campaign_status(status="SENDING"), which needs human approval. Opted-out and unreachable leads are excluded automatically and cannot be included.',
    domain: 'campaigns',
    // Matches the draft-only precedent set by `jeeta.create_social_campaign`:
    // authoring an inert row is a `campaigns.write` act; the REST controller's
    // `campaigns.send` is still required to LAUNCH it, via set_campaign_status.
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('Campaign name, for the panel.'),
      channel: z
        .enum(['EMAIL', 'SMS', 'WHATSAPP'])
        .describe('Delivery channel. SMS additionally requires the "sms" package feature. For voice, use jeeta.create_voice_campaign.'),
      subject: z.string().max(200).optional().describe('Email subject line (EMAIL only).'),
      body: z.string().min(1).max(20000).describe('Message body. An unsubscribe footer and link tracking are added at send time.'),
      bodyHtml: z.string().max(200000).optional().describe('HTML body (EMAIL only).'),
      emailTemplateId: z.string().max(64).optional().describe('Email template id to render from (see jeeta.list_email_templates).'),
      audienceFilter: audienceFilterSchema,
      scheduledAt: z
        .string()
        .optional()
        .describe('ISO 8601 time to send at. Only takes effect once the campaign is launched; omit to send on launch.'),
      iysMessageType: z
        .enum(['TICARI', 'BILGILENDIRME'])
        .optional()
        .describe(
          'Turkish İYS classification (SMS only; ignored on other channels). TICARI = commercial, and every recipient is checked against the İYS consent registry before sending. BILGILENDIRME = informational/transactional.',
        ),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'campaigns');
      return deps.campaigns.create(ctx.workspaceId, {
        name: String(args.name ?? ''),
        channel: String(args.channel ?? ''),
        body: String(args.body ?? ''),
        ...(args.subject !== undefined ? { subject: String(args.subject) } : {}),
        ...(args.bodyHtml !== undefined ? { bodyHtml: String(args.bodyHtml) } : {}),
        ...(args.emailTemplateId !== undefined ? { emailTemplateId: String(args.emailTemplateId) } : {}),
        ...(args.audienceFilter !== undefined ? { audienceFilter: args.audienceFilter } : {}),
        ...(args.scheduledAt !== undefined ? { scheduledAt: String(args.scheduledAt) } : {}),
        ...(args.iysMessageType !== undefined ? { iysMessageType: String(args.iysMessageType) } : {}),
      });
    },
  });
}
