import { z } from 'zod';
import { ComplianceService } from '../../compliance/compliance.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ConsentToolDeps {
  compliance: ComplianceService;
}

/**
 * "Stop emailing me."
 *
 * A customer can say that in the middle of an ordinary conversation, and until
 * now the connector could READ it and had no way to obey it. Every send gate in
 * this product — `CampaignsService.buildAudienceWhere`, `CampaignSenderService
 * .isOptedOut`, the workflow engine — reads the lead's `emailOptOut` /
 * `smsOptOut` / `waOptOut` flag, and nothing an agent could call ever set one.
 * So the honest description of the loop was: an agent that can answer a
 * customer, and cannot honour the one instruction it is legally obliged to
 * honour.
 *
 * It goes through `ComplianceService.recordConsent` rather than writing the
 * flag, and that is the whole point of the tool. That service writes the
 * `ConsentRecord` and flips the flag in ONE transaction — its own docstring
 * explains why: a committed record whose flag never flipped is a contact who
 * keeps receiving campaigns despite an on-record opt-out, which is a KVKK/GDPR
 * divergence rather than a bug. For SMS it also mirrors to the NetGSM
 * account blacklist and enqueues the İYS push. Writing `emailOptOut` directly
 * would skip every one of those.
 */
export function registerConsentTools(registry: McpToolRegistry, deps: ConsentToolDeps): void {
  registry.register({
    name: 'jeeta.record_consent',
    description:
      'Record what a contact has told you about being contacted, and stop (or resume) contacting them ' +
      'on that channel. Use it the moment someone says "stop emailing me", "take me off the list", ' +
      '"do not text me" — in a reply, on a call, anywhere. granted:false means they opted OUT and ' +
      'every send path stops immediately; granted:true records consent and lets contact resume. ' +
      'This writes a dated consent record as well as the flag, in one transaction, because the record ' +
      'is what proves the request was honoured. For SMS it also pushes to İYS and the operator ' +
      'blacklist. Say WHERE the request came from in `source` (e.g. "email reply", "phone call") — ' +
      'an opt-out with no provenance is hard to defend later.',
    domain: 'contacts',
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    // Not approval-gated on purpose. Stopping contact is the SAFE direction,
    // and a request to stop that waits in a queue for a human is a request
    // being ignored for as long as the queue is. The opposite direction
    // (granted: true) only ever restores what a person told you themselves.
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().min(1).describe('The contact this is about.'),
      type: z
        .enum(['MARKETING_EMAIL', 'MARKETING_SMS', 'MARKETING_WHATSAPP'])
        .describe('Which channel the consent (or refusal) covers.'),
      granted: z
        .boolean()
        .describe(
          'false = they asked NOT to be contacted on this channel; true = they consented. Required, ' +
            'because a default here would guess at what a person said.',
        ),
      source: z
        .string()
        .max(200)
        .optional()
        .describe('Where the request came from — "email reply", "phone call", "web form".'),
    }),
    handler: async (ctx, args) =>
      deps.compliance.recordConsent(
        ctx.workspaceId,
        String(args.leadId),
        String(args.type),
        args.granted === true,
        { source: (args.source as string) ?? 'mcp' },
      ),
  });

  registry.register({
    name: 'jeeta.get_consents',
    description:
      'What this contact has said about being contacted, with dates and sources. Read it before ' +
      'writing to someone you are unsure about, and when answering "why did we stop mailing them". ' +
      'Read-only.',
    domain: 'contacts',
    defer: true,
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().min(1).describe('The contact to look up.'),
    }),
    handler: async (ctx, args) => deps.compliance.getConsents(ctx.workspaceId, String(args.leadId)),
  });
}
