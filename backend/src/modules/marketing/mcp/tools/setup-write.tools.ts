import { z } from 'zod';
import { TaxRatesService } from '../../tax-rates/tax-rates.service';
import { OrderFormsService } from '../../order-forms/order-forms.service';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface SetupWriteToolDeps {
  taxRates: TaxRatesService;
  orderForms: OrderFormsService;
  emailTemplates: EmailTemplatesService;
}

/**
 * The three setup gaps an agent could SEE and not close.
 *
 * `jeeta.get_setup_readiness` lists what a workspace is missing, and every gap
 * names the tool that fixes it. Three of them named nothing — tax rates, order
 * forms and email templates were readable and not writable — which made the
 * list a set of instructions for the human rather than work the agent could
 * take off them. Being told "your invoices are billing net" by something that
 * cannot add a tax rate is worse than not being told.
 *
 * All three are unattended WRITEs, and the risk classification is the same
 * argument in each case: they create CONFIGURATION inside the workspace.
 * Nothing is sent, published, charged or spent by any of them, and every one is
 * reversible from its own panel in a click. What they are NOT is the adjacent
 * things that share their pages — sending a campaign, taking a payment, issuing
 * an invoice — which stay where they are, behind their own gates.
 */
export function registerSetupWriteTools(registry: McpToolRegistry, deps: SetupWriteToolDeps): void {
  registry.register({
    name: 'jeeta.create_tax_rate',
    description:
      'Create a tax rate for this workspace (e.g. KDV 20). Invoices and order forms apply the default rate; with no rate defined every invoice bills NET, silently. Use when `jeeta.get_setup_readiness` reports `tax-rates` missing.',
    domain: 'commerce',
    // The vocabulary this catalogue actually has, not one invented to fit:
    // `jeeta.create_product` — the neighbouring catalogue write — is
    // `leads.manage`, and a tax rate is the same kind of thing, configuration
    // the sales side runs on.
    scopes: ['leads.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(80).describe('What appears on the invoice line, e.g. "KDV %20".'),
      rate: z.number().min(0).max(100).describe('Percent, 0-100. 20 means twenty percent, not 0.20.'),
      isDefault: z
        .boolean()
        .optional()
        .describe('Apply to new items automatically. Set this on the rate the business normally charges.'),
    }),
    handler: async (ctx, args) =>
      deps.taxRates.create(ctx.workspaceId, {
        name: String(args.name),
        rate: Number(args.rate),
        ...(args.isDefault !== undefined ? { isDefault: Boolean(args.isDefault) } : {}),
      } as never),
  });

  registry.register({
    name: 'jeeta.create_order_form',
    description:
      'Create a public order form so a visitor can buy without anyone being involved: it creates the lead, mints the invoice at the SERVER-resolved price and returns the payment link. Requires a product to sell (`jeeta.create_product`) and, to be payable, a payment provider the owner has configured. Use when `jeeta.get_setup_readiness` reports `order-form` missing.',
    domain: 'commerce',
    scopes: ['leads.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(160).describe('Internal name; buyers do not see it.'),
      productId: z
        .string()
        .optional()
        .describe('The product being sold. Prefer this over `items` — the price then follows the catalogue.'),
      items: z
        .array(
          z.object({
            description: z.string().min(1),
            qty: z.number().int().min(1),
            unitPrice: z.number().int().min(0).describe('MINOR units (kuruş), not lira.'),
          }),
        )
        .max(50)
        .optional()
        .describe('Fixed line items, when what is sold is not a catalogue product.'),
      currency: z.string().optional(),
      collectPhone: z.boolean().optional(),
      notes: z.string().max(2000).optional(),
    }),
    handler: async (ctx, args) => deps.orderForms.create(ctx.workspaceId, args as never),
  });

  registry.register({
    name: 'jeeta.create_email_template',
    description:
      'Create a reusable email template from content blocks. Campaigns send templates, so with none defined there is nothing for an email campaign to send. Use when `jeeta.get_setup_readiness` reports `email-templates` missing. Write the copy in the brand voice — read it first with `jeeta.get_brand_profile`.',
    domain: 'content',
    // `campaigns.write` authors campaign content; `campaigns.send` is what
    // actually mails it, and a template is authored, never sent.
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(160),
      blocks: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          'Ordered content blocks, each `{ type, ... }` — e.g. { type: "text", text: "..." }, { type: "button", label, url }, { type: "image", url }. The stored HTML is compiled from these.',
        ),
      theme: z.record(z.string(), z.unknown()).optional().describe('Optional colour/typography overrides.'),
    }),
    handler: async (ctx, args) =>
      deps.emailTemplates.create(ctx.workspaceId, {
        name: String(args.name),
        blocks: (args.blocks ?? []) as never,
        theme: args.theme as never,
      } as never),
  });
}
