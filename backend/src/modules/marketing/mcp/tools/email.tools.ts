import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { CampaignsService } from '../../campaigns/campaigns.service';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface EmailToolDeps {
  templates: EmailTemplatesService;
  campaigns: CampaignsService;
  entitlements: EntitlementsService;
}

/**
 * Faz 5 D3 — email.
 *
 * ## `jeeta.send_email` is a one-recipient CAMPAIGN, not an SMTP call
 *
 * This is the single most important decision in D3, so it is written down
 * here rather than implied by the code.
 *
 * The product has exactly one email path that enforces the rules an outbound
 * marketing message is legally required to follow, and it is the campaign
 * pipeline:
 *
 *  - `CampaignsService.buildAudienceWhere` pins `emailOptOut: false`, requires
 *    a non-null address, excludes hard-bounced (`emailBouncedAt`) and
 *    MX-invalid (`emailVerifiedStatus: 'INVALID'`) addresses, and drops
 *    soft-deleted (`deletedAt`) and merged (`mergedIntoId`) leads.
 *  - `CampaignSenderService.send()` REFUSES to send at all when
 *    `PUBLIC_BASE_URL` is unset, because without it there is no unsubscribe
 *    link — and `render()`/`renderHtml()` append that footer to every message.
 *  - `CampaignSenderService.isOptedOut()` re-checks the opt-out at SEND time,
 *    not just at audience-freeze time, so a lead who unsubscribes between
 *    launch and delivery is skipped.
 *  - `CampaignTrackingService.unsubscribe()` is what that footer links to, and
 *    it flips the flag the two checks above read.
 *
 * The obvious-looking alternatives enforce NONE of that.
 * `EmailService.sendPlainEmail/sendCampaignEmail/sendEmail` are raw nodemailer
 * calls with no lead context at all: no opt-out check, no unsubscribe footer,
 * no bounce suppression. Wrapping one of them would have produced a tool that
 * can email a customer who has unsubscribed, from an address that has already
 * hard-bounced, with no way for the recipient to opt out of the next one.
 * That is a legal problem, not a rough edge, so it was not wrapped — per the
 * rule that a send tool must go through the compliant service path or not
 * exist.
 *
 * So `jeeta.send_email` composes a real (one-recipient) EMAIL campaign and
 * launches it. The cost is a `Campaign` row per one-off email; the benefits
 * are that every guard above applies unchanged, the send is visible in the
 * campaigns list, and open/click/unsubscribe stats work exactly as they do for
 * a bulk send. Targeting one lead is expressed with the audience filter
 * `[{field: 'id', op: 'eq', value: leadId}]` — see the `LEAD_FILTER_FIELDS`
 * note in campaigns.service.ts for why `id` is allowed there.
 *
 * Consequences worth knowing:
 *  - A lead who has opted out, bounced or been deleted makes the audience
 *    empty, and `launch()` refuses with "Audience is empty (no opted-in,
 *    reachable leads match)". That refusal IS the consent check, and the
 *    agent gets it as a sentence it can relay.
 *  - If the launch fails for any reason the DRAFT campaign is removed again,
 *    so a refused send does not litter the panel with orphan drafts.
 *
 * Quiet hours: the product has no quiet-hours concept on ANY send path today
 * (grepped: no `quietHours`/send-window logic exists in the campaign, message,
 * workflow or voice senders). This tool therefore does not invent one — a
 * per-tool time window enforced in exactly one of several send paths would be
 * compliance theatre. It is a product-wide gap, recorded here so it is not
 * mistaken for an MCP-specific omission.
 */
export function registerEmailTools(registry: McpToolRegistry, deps: EmailToolDeps): void {
  registry.register({
    name: 'jeeta.list_email_templates',
    description:
      'List the saved email templates in this workspace (id, name, last updated). Use a template id with jeeta.create_campaign or jeeta.send_email to send its rendered HTML. Read-only.',
    domain: 'email',
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'campaigns');
      return deps.templates.list(ctx.workspaceId);
    },
  });

  registry.register({
    name: 'jeeta.send_email',
    description:
      'Send one email to one lead. This reaches a real person, so in APPROVAL mode it is queued for a human instead of sending immediately. The message goes out through the campaign pipeline, which means the lead is refused if they have unsubscribed, hard-bounced or have an undeliverable address, and an unsubscribe footer plus link tracking are always added. The send appears in the campaign list.',
    domain: 'email',
    // This genuinely sends, so it demands the send scope — not the `write`
    // scope the draft-authoring tools use.
    scopes: ['campaigns.send'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'SEND',
    // Dedupe key for the broker's supersede sweep: a retried turn must not
    // leave two live approval cards that each email the same person once.
    resourceType: 'lead',
    resourceIdFrom: (args) => (typeof args.leadId === 'string' ? args.leadId : undefined),
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Lead to email. The address is read from the lead record.'),
      subject: z.string().min(1).max(200).describe('Subject line.'),
      body: z.string().min(1).max(20000).describe('Plain-text body. An unsubscribe footer is appended automatically.'),
      bodyHtml: z.string().max(200000).optional().describe('Optional HTML body.'),
      emailTemplateId: z
        .string()
        .max(64)
        .optional()
        .describe('Optional saved template to render instead of bodyHtml (see jeeta.list_email_templates).'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'campaigns');
      const leadId = String(args.leadId ?? '');
      const subject = String(args.subject ?? '');
      const campaign = await deps.campaigns.create(ctx.workspaceId, {
        // Named so a human scanning the campaign list can tell a one-off
        // agent-sent email from a bulk send at a glance.
        name: `1:1 email — ${subject}`.slice(0, 120),
        channel: 'EMAIL',
        subject,
        body: String(args.body ?? ''),
        ...(args.bodyHtml !== undefined ? { bodyHtml: String(args.bodyHtml) } : {}),
        ...(args.emailTemplateId !== undefined ? { emailTemplateId: String(args.emailTemplateId) } : {}),
        audienceFilter: [{ field: 'id', op: 'eq', value: leadId }],
      });
      try {
        const launched = await deps.campaigns.launch(ctx.workspaceId, campaign.id);
        return { campaignId: campaign.id, leadId, ...launched };
      } catch (err) {
        // A refusal (opted out / unreachable / empty audience) must not leave
        // an orphan DRAFT behind. Deleting is best-effort: the original
        // refusal is the answer the caller needs, and swallowing it in favour
        // of a cleanup error would hide it.
        await deps.campaigns.remove(ctx.workspaceId, campaign.id).catch(() => undefined);
        throw err;
      }
    },
  });
}
