import { z } from 'zod';
import { MarketingOffersService } from '../../services/marketing-offers.service';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface OfferToolDeps {
  offers: MarketingOffersService;
  principals: McpPrincipalService;
}

/**
 * The artifact this pipeline closes on.
 *
 * `ALLOWED_TRANSITIONS` says a lead reaches WON through OFFER_SENT → WAITING,
 * and until now the connector could LIST offers and not make one. So an agent
 * could hold an entire sales conversation, learn what the customer needs, and
 * then stop at the exact step the funnel is built around — leaving the lead
 * wherever it found it. That is the difference between answering messages and
 * running a sale.
 *
 * ## "Send" here means RECORD, and the description says so
 *
 * `markSent` writes `status: SENT` and advances the lead to OFFER_SENT. It does
 * NOT email anything — grepped: there is no mailer on that path at all. Calling
 * the tool `send_offer` and letting a model infer that the customer now has the
 * quote would produce an agent that tells someone "I've sent it over" when
 * nothing left the building. The quote is delivered by whoever delivers it —
 * today, a person, or the agent itself with `jeeta.send_message` — and this
 * records that it happened.
 *
 * That is also why it is not approval-gated: nothing reaches a customer here.
 * The gate that matters already sits on the message that actually carries it.
 *
 * ## The lead advances inside the service, not here
 *
 * `markSent` and `markAccepted` move the lead in the SAME transaction as the
 * offer, with a compound WHERE that re-asserts the lead is still open — so a
 * `convert()` racing alongside cannot be reverted WON→OFFER_SENT. A tool that
 * flipped the offer and then called `set_lead_status` separately would lose
 * exactly that guarantee.
 */
export function registerOfferTools(registry: McpToolRegistry, deps: OfferToolDeps): void {
  /** Row-level visibility is the caller's, falling back to the declared service
   *  principal on an API-key session — the rule the tool context documents. */
  async function actor(ctx: any): Promise<[string, string]> {
    if (ctx.userId) return [ctx.userId, ctx.userRole ?? 'MANAGER'];
    const p = await deps.principals.resolve(ctx);
    return [p.id, p.role];
  }

  registry.register({
    name: 'jeeta.create_offer',
    description:
      'Draft an offer for a lead — the artifact this pipeline closes on. Nothing is sent and nobody is ' +
      'told: it creates a DRAFT you can still edit. Quote only what the workspace actually sells; if ' +
      'you are pricing a catalogue plan pass its planId so the plan facts are snapshotted onto the ' +
      'offer, and use customPrice only for a genuinely bespoke number. `discount` is a PERCENTAGE. ' +
      'Set validUntil when the price is time-bound — an offer sent after its own validUntil is ' +
      'refused rather than born expired. Record the offer with jeeta.mark_offer_sent once the ' +
      'customer actually has it.',
    domain: 'leads',
    defer: true,
    scopes: ['leads.write'],
    risk: 'WRITE',
    // A DRAFT row. Nothing reaches the customer until something carries it.
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Who the offer is for.'),
      planId: z
        .string()
        .max(64)
        .optional()
        .describe('Catalogue plan being quoted. Its display facts are snapshotted onto the offer.'),
      customPrice: z
        .number()
        .min(0)
        .optional()
        .describe('A bespoke price. Leave out when quoting a catalogue plan at its own price.'),
      discount: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Discount as a PERCENTAGE, not an amount.'),
      trialDays: z.number().int().min(0).optional().describe('Trial length in days, when one applies.'),
      notes: z
        .string()
        .max(4000)
        .optional()
        .describe('What was agreed and why — the context whoever picks this up will need.'),
      validUntil: z
        .string()
        .max(40)
        .optional()
        .describe('ISO 8601. Sending an offer past its own validUntil is refused.'),
    }),
    handler: async (ctx, args) => {
      const [id, role] = await actor(ctx);
      return deps.offers.create(ctx.workspaceId, args as never, id, role);
    },
  });

  registry.register({
    name: 'jeeta.mark_offer_sent',
    description:
      'Record that the customer now HAS the offer, and move the lead to OFFER_SENT. Read this ' +
      'carefully: it does NOT email anything. It writes down that the quote was delivered — by you ' +
      'with jeeta.send_message, by a rep, on a call — and advances the pipeline in the same ' +
      'transaction. Call it AFTER the customer actually has it, never as a way of sending it. Only a ' +
      'DRAFT can be marked sent, the lead must still be open, and an offer already past its own ' +
      'validUntil is refused rather than recorded as freshly sent.',
    domain: 'leads',
    defer: true,
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      offerId: z.string().min(1).describe('The draft offer, from jeeta.list_offers.'),
    }),
    handler: async (ctx, args) => {
      const [id, role] = await actor(ctx);
      return deps.offers.markSent(ctx.workspaceId, String(args.offerId), id, role);
    },
  });

  registry.register({
    name: 'jeeta.mark_offer_accepted',
    description:
      'The customer said yes. Moves the offer to ACCEPTED and the lead to WAITING — the ' +
      '"accepted, awaiting provisioning" state. This records a DECISION the customer made; it does ' +
      'not provision anything, charge anything or mark the lead WON. Turning an accepted offer into a ' +
      'live customer is a separate, heavier step a person still runs.',
    domain: 'leads',
    defer: true,
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      offerId: z.string().min(1).describe('The sent offer the customer accepted.'),
    }),
    handler: async (ctx, args) => {
      const [id, role] = await actor(ctx);
      return deps.offers.markAccepted(ctx.workspaceId, String(args.offerId), id, role);
    },
  });

  registry.register({
    name: 'jeeta.mark_offer_rejected',
    description:
      'The customer said no to this offer. Records the refusal against the offer. It does NOT close ' +
      'the lead — a rejected price is often the start of the real conversation, so move the lead to ' +
      'LOST separately with jeeta.set_lead_status and a reason in their own words, and only when they ' +
      'have actually walked away.',
    domain: 'leads',
    defer: true,
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      offerId: z.string().min(1).describe('The offer that was turned down.'),
    }),
    handler: async (ctx, args) => {
      const [id, role] = await actor(ctx);
      return deps.offers.markRejected(ctx.workspaceId, String(args.offerId), id, role);
    },
  });
}
